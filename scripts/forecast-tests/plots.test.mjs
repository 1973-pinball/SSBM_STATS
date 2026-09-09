import test from "node:test";
import assert from "node:assert/strict";
import { scorePredictions } from "../lib/forecast/evaluation.mjs";
import { calibrationSvg } from "../lib/forecast/plots.mjs";

function fixture() {
  const models = ["neutral", "higher-seed", "recency-elo"].map((id) => ({ id, name: id,
    scores: scorePredictions([{ p: 0.5, actual: 1 }, { p: 0.5, actual: 0 }, { p: 0.95, actual: 1 }]) }));
  return { seeds: { allowHistorical: true }, outOfSample: { models }, inSample: { models } };
}

test("calibration plots skip empty bins, keep descriptive uncertainty and label historical assumptions", () => {
  const svg = calibrationSvg(fixture());
  assert.equal((svg.match(/<circle /g) ?? []).length, 6);
  assert.equal((svg.match(/Observed win fraction/g) ?? []).length, 3);
  assert.match(svg, /Conditional on realized matchups/);
  assert.match(svg, /not cluster-adjusted/);
  assert.match(svg, /availability is unverified/);
  assert.doesNotMatch(svg, /NaN|Infinity|<script|https?:\/\/(?!www.w3.org)/);
  assert.match(calibrationSvg(fixture(), { inSample: true }), /not validation/);
});

test("plots handle empty samples and escape unexpected text; invalid probabilities fail", () => {
  const report = fixture();
  report.seeds.allowHistorical = false;
  report.outOfSample.models = [{ id: "other", name: '<script>alert("x")</script>', scores: scorePredictions([]) }];
  const svg = calibrationSvg(report);
  assert.match(svg, /&lt;script&gt;/);
  assert.match(svg, /Strict seed mode/);
  assert.doesNotMatch(svg, /<circle|<script|NaN|Infinity/);
  const invalid = fixture();
  invalid.outOfSample.models[0].scores.calibration[5].meanP = 2;
  assert.throws(() => calibrationSvg(invalid), /Invalid calibration point/);
});
