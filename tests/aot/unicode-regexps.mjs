// Regular expressions that decode surrogate pairs (u and v flags), on Latin-1 and 16-bit subjects, with surrogate pairs at the start,
// the end and in the middle, and lone leading and trailing surrogates: compiled into the image, their slow path is part of their own
// code (an image has no VM to take the thunk from).
const subjects = ["plain ascii", "box ─│┌┐ drawing", "emoji 😀👍🏽 here", "lone \uD800 surrogate", "trail \uDC00 alone", "pair at end 😀", "😀", "\uD83D",
	"mixed é漢字😀x", "a".repeat(50) + "😀".repeat(20), "\uDC00\uD800", "x\uD83D"];
const patterns = [/\p{L}+/gu, /./gu, /[\u{1F600}-\u{1F64F}]/gu, /\p{Extended_Pictographic}/gu, /(?<w>\w+)\s/gu, /[^\x00-\x7F]/gu, /\S+$/u, /^.{3}/u,
	/\p{Emoji_Presentation}|\p{Lu}/gv, /[\p{L}--[a-z]]/gv, /(?<=\p{L})\d|[\uD800-\uDBFF]/gu, /\P{ASCII}{2,}/gu];
const out = [];
// (Several rounds: the first match of a pattern is not the only one that matters.)
for (let round = 0; round < 3; round++) {
	for (const p of patterns) {
		for (const s of subjects) {
			p.lastIndex = 0;
			const found = p.global ? [...s.matchAll(p)].map((m) => `${m.index}:${m[0]}`) : (p.exec(s) ?? []).map(String);
			out.push(`${p.source} ${JSON.stringify(found)} ${s.replace(p, "#").length} ${s.split(p).length}`);
		}
	}
}
console.log(out.join("\n"));
