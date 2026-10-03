// Loops that read module and closure variables, which the fast copy of a loop takes for what the program writes to them (numbers
// here), behind a check: the loop runs before the variable is assigned (undefined), the variable changes type later, is assigned
// undefined on purpose, holds an array or a typed array, and a closure variable read in its temporal dead zone.
const out = [];
const log = (...a) => out.push(a.map(String).join(" "));

function sumTo() { let s = 0; for (let i = 0; i < LIMIT; i++) s = (s + i) | 0; return s; }
function countDown() { let n = 0; for (let i = START; i > 0; i--) n++; return n; }
function scaled() { let s = 0; for (let i = 0; i < 100; i++) s += i * FACTOR; return s; }
log("before assignment:", sumTo(), countDown(), scaled());

var LIMIT = 100000;
var START = 1000;
var FACTOR = 3;
log("after assignment:", sumTo(), countDown(), scaled());

let mixed = 10;
function loopsTo() { let s = 0; for (let i = 0; i < mixed; i++) s++; return s; }
log("number:", loopsTo());
mixed = "25";
log("string:", loopsTo());
mixed = 5.5;
log("double:", loopsTo());

let maybe = 7;
function untilMaybe() { let s = 0; for (let i = 0; i < 10; i++) if (i === maybe) s += 100; else s++; return s; }
log("defined:", untilMaybe());
maybe = undefined;
log("undefined on purpose:", untilMaybe());

const items = [1, 2, 3, 4, 5];
const bytes = new Uint8Array([5, 6, 7]);
function sumItems() { let s = 0; for (let i = 0; i < items.length; i++) s += items[i]; return s; }
function sumBytes() { let s = 0; for (let i = 0; i < bytes.length; i++) s += bytes[i]; return s; }
log("array and typed array:", sumItems(), sumBytes());

// A closure variable in its temporal dead zone: the generic copy throws.
function tdz() {
	const reader = () => { let s = 0; for (let i = 0; i < 3; i++) s += late; return s; };
	let caught = "none";
	try { reader(); } catch (e) { caught = e.constructor.name; }
	let late = 2;
	return [caught, reader()].join(",");
}
log("tdz:", tdz());

// A variable written inside the loop: not taken for anything.
let shared = 0;
function writes() { for (let i = 0; i < 1000; i++) shared += i % 3; return shared; }
log("written in loop:", writes(), writes());
console.log(out.join("\n"));
