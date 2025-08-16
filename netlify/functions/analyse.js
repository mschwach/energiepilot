mkdir -p netlify/functions
cat > netlify/functions/analyse.js <<'EOF'
// netlify/functions/analyse.js

const rules = require('./energiepilot_rules.json');

function passes(cond, data) {
  const v = data?.[cond.field];
  if (cond.eq  !== undefined) return v === cond.eq;
  if (cond.lte !== undefined) return Number(v) <= Number(cond.lte);
  if (cond.gte !== undefined) return Number(v) >= Number(cond.gte);
  if (cond.in  !== undefined) return Array.isArray(cond.in) && cond.in.includes(v);
  return true;
}

function computeRate(program, input) {
  const f = program.funding || {};
  let rate = 0;

  if (f.type === 'kredit_tilgungszuschuss') {
    if (f.base_rate_pct_by_eh && input.target_eh_class) {
      rate = f.base_rate_pct_by_eh[input.target_eh_class] || 0;
    }
    if (input.use_ee_class && f.ee_class_bonus_pct) rate += f.ee_class_bonus_pct;

    let boni = 0;
    if (f.optional_boni) {
      if (input.has_wpb_bonus && f.optional_boni.WPB)       boni += f.optional_boni.WPB;
      if (input.has_sersan_bonus && f.optional_boni.SerSan) boni += f.optional_boni.SerSan;
      const cap = f.optional_boni.boni_cap_pct || program.calculation?.total_bonus_cap_pct || boni;
      rate += Math.min(boni, cap);
    }
    return rate;
  }

  if (f.type === 'zuschuss') {
    rate = f.base_rate_pct || 0;
    if (f.isfp_bonus_pct && input.has_isfp) rate += f.isfp_bonus_pct;

    if (Array.isArray(f.bonuses)) {
      for (const b of f.bonuses) {
        const ok = (b.if_all || []).every(c => passes(c, input));
        if (!ok) continue;
        if (b.add_pct)     rate += b.add_pct;
        if (b.add_pct_max) rate += b.add_pct_max;
      }
    }

    const globalCap = rules.globals?.bafa_em?.zuschuss_max_total_pct;
    const cap = program.caps?.zuschuss_total_cap_pct ?? globalCap;
    if (cap) rate = Math.min(rate, cap);
    return rate;
  }

  return null;
}

function filterByMeasure(programs, input) {
  const sel = input.measure_selected;
  if (!sel) return programs;

  if (sel === 'Heizungstausch_WP') {
    const hasKfW458 = programs.some(p => p.key === 'KFW_458');
    return programs.filter(p => {
      if (hasKfW458 && p.key === 'BAFA_EM_WAERMEPUMPE') return false;
      const m = Array.isArray(p.measure) ? p.measure : [];
      return m.includes(sel) || p.key === 'KFW_458';
    });
  }

  return programs.filter(p => {
    const m = Array.isArray(p.measure) ? p.measure : [];
    return m.includes(sel);
  });
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: 'Method Not Allowed' };
    }

    let input = {};
    try {
      input = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, body: 'Invalid JSON body' };
    }

    let eligible = (rules.programs || []).filter(p =>
      (p.eligibility_if || []).every(c => passes(c, input))
    );

    eligible = filterByMeasure(eligible, input);

    const results = eligible.map(p => {
      const f = p.funding || {};
      const rate = computeRate(p, input);

      const maxAmount =
        f.max_amount_eur ??
        f.max_amount_eur_per_we ??
        f.max_amount_eur_range ??
        null;

      return {
        key: p.key,
        agency: p.agency,
        program_no: p.program_no,
        label: p.label,
        measure: p.measure,
        funding_type: f.type || null,
        rate_pct: rate,
        max_amount: maxAmount,
        notes: p.calculation?.notes || []
      };
    });

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: true, input, results }, null, 2)
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ok: false,
        errorType: err?.name || 'Error',
        errorMessage: err?.message || String(err),
        trace: (err?.stack || '').split('\n').map(s => s.trim())
      }, null, 2)
    };
  }
};
EOF
