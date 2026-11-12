import { LIKELY_STOP_LANES } from '@runway/routing';

export default function Home() {
  return (
    <main>
      <h1>RunWay Routes</h1>
      <p>Running routes with fewer stops, ready to download to your COROS or Garmin watch.</p>
      <p>
        In development. Likely stops are traffic signals and crossings of {LIKELY_STOP_LANES} or more lanes.
      </p>
    </main>
  );
}
