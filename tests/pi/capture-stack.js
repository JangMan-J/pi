// An extension that jiti transforms (it imports a host package), which installs jiti's Error.prepareStackTrace wrapper, and that
// then does what follow-redirects (so axios, and every extension that uses it) does when it is loaded:
// Error.captureStackTrace() on an object that is not an Error. V8 takes any object. The runtime's default prepareStackTrace
// threw "First argument must be an Error object", and the extension failed to load.
import { Type } from "typebox";

const holder = {};
Error.captureStackTrace(holder);
class CustomError {
	constructor() {
		Error.captureStackTrace(this, CustomError);
	}
}
const custom = new CustomError();
export default function () {
	console.log(`capture-stack: plain=${typeof holder.stack} custom=${typeof custom.stack} host=${typeof Type.String}`);
	// (There is no model to answer the prompt.)
	process.exit(0);
}
