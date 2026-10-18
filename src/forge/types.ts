export interface ToolTest {
  name: string;
  input: Record<string, unknown>;
  /** JS expression over `result` and `input` that must be truthy. */
  assert: string;
  /** Trusted cross-check: fetches the true values for `input` from the source; a number in the speech must match one. */
  reference?: Reference;
}

export interface Reference {
  /**
   * ES module whose default export `async (input, { fetched })` returns what the source reports; `fetched` lists the URLs the skill requested:
   * `(number | string)[]` (the answer must match one number, or quote one headline), `{ every: string[] }` (it must quote each),
   * or `{ anyOf: string[] }` (it must name one of them, as whole words: a capital city, a person).
   */
  code: string;
  relTol?: number;
  absTol?: number;
}

/** Everything the smith produces for one capability. */
export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** ES module source; default export is `async function run(input)` returning `{ speech, data? }`. */
  code: string;
  allowedDomains: string[];
  tests: ToolTest[];
  /** Human names of the data sources, cited in every answer (e.g. "Open-Meteo"). */
  sources?: string[];
}

export interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  durationMs: number;
  result?: unknown;
  /** What the cross-check compared: a number in the answer and the source's own value. */
  crossCheck?: { said?: number | string; source?: number | string; tolerance?: number; skipped?: string };
}

export interface TestReport {
  passed: boolean;
  results: TestResult[];
  fetched: string[];
  logs: string;
}

export type CapabilityStatus = "pending" | "active";

export interface Capability {
  id: string;
  status: CapabilityStatus;
  spec: ToolSpec;
  request: string;
  createdAt: string;
  approvedAt?: string;
  attempts: number;
  testReport: TestReport;
  uses: number;
}

export interface ForgeEvent {
  stage: "thinking" | "probe" | "submit" | "test" | "repair" | "ready" | "failed";
  message: string;
}
