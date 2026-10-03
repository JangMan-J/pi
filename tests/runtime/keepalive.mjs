// keepalive.mjs URL IDLE_MS...: a request, then one after each idle time; prints which connection each was answered on (1 for
// the first request's, as the server counts them), or the error of one that was not answered within 3 seconds.
const url = process.argv[2];
const request = () =>
	fetch(url, { method: "POST", body: "{}", signal: AbortSignal.timeout(3000) }).then(
		(response) => response.text(),
		(error) => error.name,
	);
const answers = [await request()];
for (const idle of process.argv.slice(3).map(Number)) {
	await new Promise((resolve) => setTimeout(resolve, idle));
	answers.push(await request());
}
// Counted from the first, whatever number the server is at.
const first = Number(answers[0]);
console.log(answers.map((answer) => (Number.isNaN(Number(answer)) ? answer : Number(answer) - first + 1)).join(" "));
