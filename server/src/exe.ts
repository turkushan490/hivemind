// Entry point for the Windows .exe (bundled by esbuild, packed into a single file by @yao-pkg/pkg).
// It only prepares the environment (writable data dir, baked-in web UI) and then runs the normal server.
import './exe-env.js';
import './main.js';
