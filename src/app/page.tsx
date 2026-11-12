import { getDashboard } from "@/lib/store";
import DemoPanel from "./demo-panel";
import ComparisonPanel from "./comparison-panel";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function Home() {
  const data = await getDashboard();
  return (
    <main>
      <a className="skip-link" href="#workspace">Skip to workspace</a>
      <header className="topbar">
        <a className="brand" href="#workspace" aria-label="Keepwell home"><span className="brand-mark" aria-hidden="true">k.</span>keepwell<span className="brand-dot" aria-hidden="true" /></a>
        <nav aria-label="Main navigation"><a href="#workspace">Overview</a><a href="#decisions">Decisions</a><a href="#comparison">Scenario simulation</a></nav>
        <span className="environment"><span aria-hidden="true" />Synthetic demo</span>
      </header>
      <section className="page-heading" id="workspace">
        <div><p className="eyebrow">MERCHANT RECOVERY WORKSPACE</p><h1>Keep the relationship.<br /><span>Choose the next move.</span></h1><p className="intro">Every failed renewal deserves a considered response. Follow an event from customer context to a saved decision.</p><a className="primary-button hero-cta" href="#simulation-title">Try a recovery decision <span aria-hidden="true">↘</span></a></div>
        <aside className="checkpoint-note"><span className="small-label">DECISION ENGINE CHECKPOINT</span><strong>Six levers. One next move.</strong><p>Eligibility, trained synthetic propensity, priority and concession reservations.</p><span className="policy-pill">recovery-v1</span></aside>
      </section>
      <DemoPanel {...data} />
      <ComparisonPanel />
      <footer><span>Keepwell</span><p>Sandbox only. Synthetic customer data. No real money moves.</p><a href="#workspace">Back to top ↑</a></footer>
    </main>
  );
}
