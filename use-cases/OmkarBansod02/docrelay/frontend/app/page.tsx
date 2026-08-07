import { SystemHealth } from "./system-health";

const foundations = [
  {
    title: "Cloud stays authoritative",
    body: "Every future plan is bound to one stable provider file and one exact source revision.",
  },
  {
    title: "Review has lineage",
    body: "Proposals, human decisions, and replacement rounds remain distinct evidence.",
  },
  {
    title: "Uncertainty stops work",
    body: "Unsupported mappings, concurrent changes, and ambiguous effects are explicit outcomes.",
  },
];

export default function Home() {
  return (
    <main>
      <header className="masthead">
        <a className="wordmark" href="#top" aria-label="DocRelay home">
          DocRelay
        </a>
        <span className="phase">Foundation · Phase 1</span>
      </header>

      <section id="top" className="hero">
        <p className="eyebrow">Safe AI write-back for cloud documents</p>
        <h1>Approved changes move forward. Uncertainty does not.</h1>
        <p className="lede">
          DocRelay is the control plane between an authoritative cloud document and SuperDocs. This
          build is the production scaffold; provider sync, AI editing, review, and write-back are not
          implemented yet.
        </p>
      </section>

      <SystemHealth />

      <section className="principles" aria-label="Architecture foundations">
        {foundations.map((foundation) => (
          <article key={foundation.title}>
            <h2>{foundation.title}</h2>
            <p>{foundation.body}</p>
          </article>
        ))}
      </section>

      <footer>
        <span>Production-shaped foundation</span>
        <span>No connected providers or sample run data</span>
      </footer>
    </main>
  );
}
