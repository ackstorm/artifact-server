import {defineConfig} from "vitest/config";

/** Serial, process-isolated runner for Docker- and cluster-backed suites; each script passes its file and timeouts. */
export default defineConfig({
  test: {
    fileParallelism: false,
    pool: "forks",
  },
});
