// Small dependency-free static scientific plot, kept outside the browser app.
const escapeXml = (value) => String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[ch]);
const LABELS = { neutral: "Neutral 50/50", "higher-seed": "Higher seed", "recency-elo": "Recency event-batch Elo",
  glicko2: "Glicko-2", "dynamic-bradley-terry": "Dynamic Bradley-Terry",
  "regularized-bt-recent-form": "Regularized BT + seed + form" };
const finiteProbability = (n) => Number.isFinite(n) && n >= 0 && n <= 1;

/** Point estimates and descriptive Wilson whiskers; empty bins have no mark. */
export function calibrationSvg(report, { inSample = false } = {}) {
  const models = inSample ? report.inSample.models : report.outOfSample.models;
  if (!models?.length) throw new Error("Calibration plot needs model scores");
  const panelWidth = 360;
  const columns = Math.min(3, models.length);
  const rows = Math.ceil(models.length / columns);
  const rowHeight = 520;
  const width = 70 + panelWidth * columns;
  const height = 615 + rowHeight * (rows - 1);
  const elements = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-labelledby="title desc">',
    '<title id="title">' + (inSample ? 'Retrospective in-sample calibration' : 'Chronological held-out calibration') + '</title>',
    '<desc id="desc">Probability of the hash-selected player winning versus the observed win fraction. The diagonal is perfect calibration. Whiskers show descriptive 95 percent Wilson intervals, not event-cluster uncertainty. Separate histograms show bin sample sizes. Empty bins are not plotted.</desc>',
    '<rect width="100%" height="100%" fill="#121022"/>',
    '<text x="35" y="33" style="font-size:21px">' + (inSample ? 'Retrospective calibration — not validation' : 'Event-held-out calibration — experimental') + '</text>',
    '<text x="35" y="57" class="minor">Conditional on realized matchups; hash-selected player side; same sets for all models, including fallbacks.</text>',
  ];
  models.forEach((model, index) => {
    const left = 90 + (index % columns) * panelWidth;
    const offsetY = Math.floor(index / columns) * rowHeight;
    const top = 118 + offsetY;
    const side = 270;
    const x = (p) => left + p * side;
    const y = (p) => top + (1 - p) * side;
    const bins = model.scores.calibration;
    if (!Array.isArray(bins)) throw new Error("Calibration bins are required");
    const populated = bins.filter((bin) => bin.n > 0);
    for (const bin of bins) {
      if (!Number.isInteger(bin.n) || bin.n < 0 || !finiteProbability(bin.lower) || !finiteProbability(bin.upper)
        || bin.lower >= bin.upper) throw new Error("Invalid calibration bin");
    }
    for (const bin of populated) {
      if (!finiteProbability(bin.meanP) || !finiteProbability(bin.winRate) || bin.wilson95?.length !== 2
        || !bin.wilson95.every(finiteProbability) || bin.wilson95[0] > bin.wilson95[1]) throw new Error("Invalid calibration point");
    }
    elements.push('<text x="' + left + '" y="' + (88 + offsetY) + '" style="font-size:15px">' + escapeXml(LABELS[model.id] ?? model.name) + '</text>');
    elements.push('<text x="' + left + '" y="' + (107 + offsetY) + '" class="minor">n = ' + model.scores.n + ' sets</text>');
    for (const tick of [0, 0.25, 0.5, 0.75, 1]) {
      elements.push('<line class="grid" x1="' + left + '" y1="' + y(tick) + '" x2="' + x(1) + '" y2="' + y(tick) + '"/>');
      elements.push('<line class="grid" x1="' + x(tick) + '" y1="' + top + '" x2="' + x(tick) + '" y2="' + y(0) + '"/>');
      elements.push('<text x="' + (left - 9) + '" y="' + (y(tick) + 4) + '" text-anchor="end">' + (tick * 100) + '%</text>');
      elements.push('<text x="' + x(tick) + '" y="' + (y(0) + 20) + '" text-anchor="middle">' + (tick * 100) + '%</text>');
    }
    elements.push('<line class="axis" stroke-dasharray="5 5" x1="' + x(0) + '" y1="' + y(0) + '" x2="' + x(1) + '" y2="' + y(1) + '"/>');
    for (const bin of populated) {
      const cx = x(bin.meanP);
      elements.push('<line class="data" x1="' + cx + '" y1="' + y(bin.wilson95[0]) + '" x2="' + cx + '" y2="' + y(bin.wilson95[1]) + '"/>');
      for (const end of bin.wilson95) elements.push('<line class="data" x1="' + (cx - 4) + '" y1="' + y(end) + '" x2="' + (cx + 4) + '" y2="' + y(end) + '"/>');
      elements.push('<circle class="data" cx="' + cx + '" cy="' + y(bin.winRate) + '" r="4"><title>Mean p=' + bin.meanP.toFixed(4) + '; win fraction=' + bin.winRate.toFixed(4) + '; n=' + bin.n + '</title></circle>');
    }
    elements.push('<text transform="translate(' + (left - 59) + ' ' + (top + side / 2) + ') rotate(-90)" text-anchor="middle">Observed win fraction</text>');
    elements.push('<text x="' + (left + side / 2) + '" y="' + (435 + offsetY) + '" text-anchor="middle">Predicted win probability</text>');
    const maximum = Math.max(1, ...bins.map((bin) => bin.n));
    const base = 529 + offsetY;
    const histogramHeight = 58;
    elements.push('<text x="' + left + '" y="' + (459 + offsetY) + '" class="minor">Sets per bin (each panel has its own count scale)</text>');
    elements.push('<text x="' + (left - 9) + '" y="' + (base - histogramHeight + 5) + '" text-anchor="end" class="minor">' + maximum + '</text>');
    elements.push('<text x="' + (left - 9) + '" y="' + base + '" text-anchor="end" class="minor">0</text>');
    for (const bin of populated) {
      const barHeight = histogramHeight * bin.n / maximum;
      elements.push('<rect x="' + (x(bin.lower) + 1) + '" y="' + (base - barHeight) + '" width="' + Math.max(0, side * (bin.upper - bin.lower) - 2) + '" height="' + barHeight + '" fill="#ac9dff"><title>' + bin.n + ' sets</title></rect>');
    }
    elements.push('<line class="axis" x1="' + left + '" y1="' + base + '" x2="' + x(1) + '" y2="' + base + '"/>');
  });
  elements.push('<text x="35" y="' + (565 + rowHeight * (rows - 1)) + '" class="minor">Dashed diagonal: perfect calibration. Whiskers: descriptive 95% Wilson intervals, not cluster-adjusted or forecast uncertainty.</text>');
  elements.push('<text x="35" y="' + (590 + rowHeight * (rows - 1)) + '" class="minor">' + (report.seeds.allowHistorical
    ? 'Seed results assume historical full-field seeds were available before each cutoff; availability is unverified.'
    : 'Strict seed mode: only seeds observed before cutoff qualify; missing seeds fall back to 50/50.') + '</text>');
  elements.push('</svg>');
  // Presentation attributes also render in headless SVG engines without CSS.
  return (elements.join("\n") + "\n")
    .replaceAll('class="grid"', 'stroke="#454052" stroke-width="1"')
    .replaceAll('class="axis"', 'stroke="#b4accc" stroke-width="1"')
    .replaceAll('class="data"', 'stroke="#ac9dff" fill="#ac9dff"')
    .replaceAll('class="minor"', 'font-size="12"')
    .replace(/style="font-size:(\d+)px"/g, 'font-size="$1"')
    .replace(/<text([^>]*)>/g, (_, attributes) => '<text fill="#e9e6f5" font-family="Arial, sans-serif"'
      + (attributes.includes('font-size=') ? '' : ' font-size="13"') + attributes + '>');
}
