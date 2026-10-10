import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const moduleRequire = createRequire(import.meta.url);
const TUI_PACKAGE_NAME = "@earendil-works/pi-tui";

export interface NativeModuleCandidateOptions {
	moduleUrl?: string;
	execPath?: string;
	resolvePackage?: (specifier: string) => string;
}

/** A module embedded in a compiled Bun executable (`/$bunfs/` on POSIX, `B:/~BUN/` on Windows). */
function isEmbeddedModule(moduleUrl: string): boolean {
	return moduleUrl.includes("$bunfs") || moduleUrl.includes("~BUN") || moduleUrl.includes("%7EBUN");
}

export function getNativeModuleCandidates(nativePath: string, options: NativeModuleCandidateOptions = {}): string[] {
	const moduleUrl = options.moduleUrl ?? import.meta.url;
	const moduleDir = dirname(fileURLToPath(moduleUrl));
	const candidates: string[] = [];

	// A compiled executable resolves a package from its embedded modules in the working directory's node_modules, so a
	// repository Pi is started in could supply the native module. It has no installed TUI package: its native modules are
	// next to the executable.
	if (!isEmbeddedModule(moduleUrl)) {
		try {
			const packageEntry = (options.resolvePackage ?? moduleRequire.resolve)(TUI_PACKAGE_NAME);
			candidates.push(join(dirname(packageEntry), "..", nativePath));
		} catch {
			// Not installed as a package.
		}
	}

	candidates.push(
		join(moduleDir, "..", nativePath),
		join(moduleDir, nativePath),
		join(dirname(options.execPath ?? process.execPath), nativePath),
	);
	return Array.from(new Set(candidates));
}
