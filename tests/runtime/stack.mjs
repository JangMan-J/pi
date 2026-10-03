// Error.captureStackTrace() and the default Error.prepareStackTrace on objects that are not Errors, as V8 has them: a
// prepareStackTrace that wraps the default one (source-map support, Babel's, jiti's) hands it whatever captureStackTrace() was
// given, and packages call that on plain objects (follow-redirects, so axios, does when it is loaded).
const out = [];
const head = (stack) => String(stack).split("\n")[0];

const plain = {};
Error.captureStackTrace(plain);
out.push(`plain: ${typeof plain.stack} ${head(plain.stack)}`);

// (What heads the stack of an object with a name or a message of its own differs from V8's, and is not checked here.)
class NotAnError { constructor() { Error.captureStackTrace(this, NotAnError); } }
const instance = new NotAnError();
out.push(`class: ${typeof instance.stack} ${head(instance.stack)} ${instance.stack.includes("NotAnError") ? "with" : "without"} the constructor's frame`);

// The wrapper, as a source-map library installs it.
const original = Error.prepareStackTrace;
out.push(`default is a function: ${typeof original === "function"}`);
let wrapped = 0;
Error.prepareStackTrace = (error, trace) => { wrapped++; return original ? original(error, trace) : `${error}\n${trace.join("\n")}`; };
const viaWrapper = {};
Error.captureStackTrace(viaWrapper);
out.push(`through a wrapper: ${typeof viaWrapper.stack} ${head(viaWrapper.stack)}`);
const realError = new RangeError("real");
out.push(`an Error through the wrapper: ${head(realError.stack)}`);
out.push(`the wrapper ran: ${wrapped > 0}`);
Error.prepareStackTrace = original;

if (typeof original === "function") {
	out.push(`called with an object: ${head(original({ name: "N", message: "m" }, []))}`);
	out.push(`called with an Error: ${head(original(new TypeError("t"), []))}`);
	for (const value of [undefined, null, 1, "s"]) {
		try {
			original(value, []);
			out.push(`called with ${value}: no error`);
		} catch (e) {
			out.push(`called with ${value}: ${e.constructor.name}`);
		}
	}
}
console.log(out.join("\n"));
