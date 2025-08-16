const fs = require('fs');
const path = require('path');

// Load rules JSON bundled alongside the function
const rulesPath = path.join(__dirname, 'energiepilot_rules.json');
const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));

// Simple helper for condition checks
function passes(cond, data) {
  const v = data[cond.field];
  if (cond.eq !== undefined) return v === cond.eq;
  if (cond.lte !== undefined) return Number(v) <= Number(cond.lte);
  if (cond.gte !== undefined) return Number(v) >= Number(cond.gte);
  if (cond.in !== undefined) return Array.isArray(cond.in) && cond.in.includes(v);
  return true;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let input = {};
  try {
    input = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: 'Invalid JSON body' };
  }

  const eligible = rules.programs.filter(p => {
    const conds = p.eligibility_if || [];
    return conds.every(c => passes(c, input));
  });

  const results = eligible.map(p => {
    const f = p.funding || {};
    // base rate
    let rate = 0;

    if (f.type === 'kredit_tilgungszuschuss' && f.base_rate_pct_by_eh && input.target_eh_class) {
      rate = f.base_rate_pct_by_eh[input.target_eh_class] || 0;
      if (input.use_ee_class && f.ee_class_bonus_pct) rate += f.ee_class_bonus_pct;
      // optional boni (gedeckelt)
      let boni = 0;
      if (f.optional_boni) {
        if (input.has_wpb_bonus && f.optional_boni.WPB) boni += f.optional_boni.WPB;
        if (input.has_sersan_bonus && f.optional_boni.SerSan) boni += f.optional_boni.SerSan;
        const cap = f.optional_boni.boni_cap_pct || p.calculation?.total_bonus_cap_pct;
        rate += Math.min(boni, cap || boni);
      }
    } else if (f.type === 'zuschuss') {
      rate = f.base_rate_pct || 0;
      if (f.isfp_bonus_pct && input.has_isfp) rate += f.isfp_bonus_pct;
      if (Array.isArray(f.bonuses)) {
        for (const b of f.bonuses) {
          const ok = (b.if_all || []).every(c => passes(c, input));
          if (!ok) continue;
          if (b.add_pct) rate += b.add_pct;
          if (b.add_pct_max) rate += b.add_pct_max; // simple max-add for MVP
        }
      }
      // Cap (BEG EM: 70%)
      const cap = (p.caps && p.caps.zuschuss_total_cap_pct) || (rules.globals?.bafa_em?.zuschuss_max_total_pct);
      if (cap) rate = Math.min(rate, cap);
    }

    return {
      key: p.key,
      program: `${p.agency} ${p.program_no}`,
      label: p.label,
      funding_type: f.type || null,
      rate_pct: rate || null,
      max_amount_eur: f.max_amount_eur || f.max_amount_eur_per_we || f.max_amount_eur_range || null,
      notes: p.calculation?.notes || []
    };
  });

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ok: true, input, results }, null, 2)
  };
};