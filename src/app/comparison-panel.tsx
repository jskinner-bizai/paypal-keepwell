import { compareScenarios } from "@/lib/scenario-comparison";
import { DEFAULT_BUDGET } from "@/lib/engine";

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
export default function ComparisonPanel() {
  const comparison = compareScenarios();
  const { champion, challenger, delta } = comparison;
  return <section id="comparison" className="panel customer-panel" aria-labelledby="comparison-title">
    <div className="section-heading"><div><p className="eyebrow">SCENARIO SIMULATION ON SYNTHETIC DATA</p><h2 id="comparison-title">Reminder-only vs. next best action</h2></div><span className="subtle-badge">54 cases, two policy replays</span></div>
    <p className="muted">Same synthetic customers, shared outcome draws, separate budgets. Illustrative 30-day outcomes under stated assumptions, not real merchant lift.</p>
    <div className="table-scroll" role="region" aria-label="Synthetic scenario comparison" tabIndex={0}>
      <table><caption className="sr-only">Scenario simulation on synthetic data, fixed evaluation seed 20261103</caption><thead><tr><th scope="col">Simulated metric</th><th scope="col" className="numeric">Reminder-only</th><th scope="col" className="numeric">Keepwell</th><th scope="col" className="numeric">Difference</th></tr></thead>
        <tbody>
          <tr><th scope="row">Customer saves</th><td className="numeric">{champion.saves}</td><td className="numeric">{challenger.saves}</td><td className="numeric">{delta.saves}</td></tr>
          <tr><th scope="row">Gross revenue</th><td className="numeric">{money(champion.grossRevenueCents)}</td><td className="numeric">{money(challenger.grossRevenueCents)}</td><td className="numeric">{money(delta.grossRevenueCents)}</td></tr>
          <tr><th scope="row">Assumed concession spend</th><td className="numeric">{money(champion.concessionSpendCents)}</td><td className="numeric">{money(challenger.concessionSpendCents)}</td><td className="numeric">{money(delta.concessionSpendCents)}</td></tr>
          <tr><th scope="row">Net after concessions</th><td className="numeric">{money(champion.netRevenueCents)}</td><td className="numeric">{money(challenger.netRevenueCents)}</td><td className="numeric">{money(delta.netRevenueCents)}</td></tr>
        </tbody>
      </table>
    </div>
    <p className="form-note">Keepwell reserves {money(challenger.reservedConcessionCents)} of the {money(DEFAULT_BUDGET.monthlyLimitCents)} scenario budget. Approval and buyer consent are simulated separately. This is a paired policy replay, not a randomized holdout.</p>
    <details><summary>See the simulation assumptions</summary><p>{comparison.methodology}</p><ul>{comparison.assumptions.map(assumption => <li key={assumption}>{assumption}</li>)}</ul><p>Model: {comparison.modelVersion}. Training seed {comparison.trainingSeed}; calibration seed {comparison.calibrationSeed}; evaluation seed {comparison.evaluationSeed}.</p></details>
  </section>;
}
