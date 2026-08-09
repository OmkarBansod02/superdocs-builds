import Link from "next/link";

import { GoogleDrivePanel } from "./google-drive-panel";

export default function GoogleDrivePage() {
  return (
    <main>
      <header className="masthead">
        <Link className="wordmark" href="/" aria-label="DocRelay home">
          DocRelay
        </Link>
        <span className="phase">Phase 2.5 · Google Picker</span>
      </header>

      <section className="picker-hero">
        <p className="eyebrow">Source authorization</p>
        <h1>Authorize a Google Drive source</h1>
        <p className="lede">
          Select a native Google Doc through Picker to authorize it for this application under
          drive.file. The backend will then validate and capture a baseline.
        </p>
      </section>

      <GoogleDrivePanel />
    </main>
  );
}
