export interface ToolTest {
  name: string;
  input: Record<string, unknown>;
  /** JS expression over `result` and `input` that must be truthy. */
  assert: string;
  /** Trusted cross-check: fetches the true values for `input` from the source; a number in the speech must match one. */
  reference?: Reference;
}

export interface Reference {
  /** ES module whose default export `async (input) => number[]` returns the values the source reports. */
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
