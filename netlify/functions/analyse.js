// netlify/functions/analyse.js
// Robustere Auswertung + failsafe Filter

const rules = require('./energiepilot_rules.json');

// ---- Helpers ---------------------------------------------------------------

function passes(cond, data) {
  const v = data?.[cond.field];

  // Gleichheit
  if (cond.eq !== undefined) return v === cond.eq;

  // Bereich / Vergleich (akzeptiere gte/lte UND ge/le)
  const gte = cond.gte !== undefined ? cond.gte : cond.ge;
  const lte = cond.lte !== undefined ? cond.lte : cond.le;

  if (gte !== undefined) return Number(v) >= Number(gte);
  if (lte !== undefined) return Number(v) <= Number(lte);

  // Menge
  if (cond.in !== undefined) {
    return Array.isArray(cond.in) && cond.in.includes(v);
  }

  // unbekannte Operatoren: nicht blockieren
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
    rate = f.base_rate_pct ?? 0;

    if (f.isfp_bonus_pct && input.has_isfp) rate += f.isfp_bonus_pct;

    if (Array.isArray(f.bonuses)) {
      for (const b of f.bonuses) {
        const ok = (b.if_all || []).every(c => passes(c, input));
        if (!ok) continue;
        if (b.add_pct != null)     rate += Number(b.add_pct);
        if (b.add_pct_max != null) rate += Number(b.add_pct_max);
      }
    }

    const globalCap = rules.globals?.bafa_em?.zuschuss_max_total_pct;
    const cap = program.caps?.zuschuss_total_cap_pct ?? globalCap;
    if (cap != null) rate = Math.min(rate, Number(cap));
    return rate;
  }

  // reine Kreditprogramme (ohne Zuschuss) -> kein Prozentsatz
  return null;
}

function filterByMeasure(programs, input) {
  const sel = input.measure_selected;
  if (!sel) return programs;

  // Spezialfall: WP – wenn KfW 458 dabei ist, blende BAFA-WP aus
  if (sel === 'Heizungstausch_WP') {
    const hasKfW458 = programs.some(p => p.key === 'KFW_458');
    return programs.filter(p => {
      if (hasKfW458 && p.key === 'BAFA_EM_WAERMEPUMPE') return false;
      const m = Array.isArray(p.measure) ? p.measure : [];
      return m.includes(sel) || p.key === 'KFW_458';
    });
  }

  // Standard: nur Programme, die die Maßnahme führen
  return programs.filter(p => {
    const m = Array.isArray(p.measure) ? p.measure : [];
    return m.includes(sel);
  });
}

// ---- Handler ---------------------------------------------------------------

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

    // 1) Eligibility
    const eligible = (rules.programs || []).filter(p =>
      (p.eligibility_if || []).every(c => passes(c, input))
    );

    // 2) Maßnahmenfilter
    let afterFilter = filterByMeasure(eligible, input);

    // Failsafe: nie komplett leer zurückgeben, sonst ist UX verwirrend
    if (!afterFilter.length) afterFilter = eligible;

    // 3) Ergebnis strukturieren
    const results = afterFilter.map(p => {
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

    // 4) Response inkl. kleinem Debug
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ok: true,
        input,
        eligible_before_filter: eligible.map(p => p.key),
        eligible_after_filter: afterFilter.map(p => p.key),
        results
      }, null, 2)
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
