import { readFileSync } from "node:fs";
import type { NextConfig } from "next";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

const nextConfig: NextConfig = {
	env: { LH_VERSION: pkg.version },
	output: "standalone",
	outputFileTracingExcludes: {
		// Learner data, M3Kang data and secrets never ship inside a build.
		"*": ["**/data/**/*", ".env*"],
	},
	outputFileTracingIncludes: {
		// The practice bridge runs as a separate Python process.
		"*": ["practice/bridge.py"],
	},
};

export default nextConfig;
