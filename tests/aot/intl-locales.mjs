// Which locales each Intl constructor says it supports, and what it resolves some to: on macOS the runtime makes the language tags of
// ICU's lists of locales itself when they are plain (language, script, region), and they must be what ICU makes of them.
const candidates = [];
for (const l of ["en","en-US","en-GB","zh","zh-Hant-TW","zh-Hans-CN","es-419","sr-Latn","sr-Cyrl-RS","pt-BR","he","iw","in","id","no","nb","tl","fil","mo","ro","sh","en-US-POSIX","de-CH","ar-001","yue-Hant-HK","ckb","az-Latn-AZ","uz-Arab-AF","ca-ES-valencia","ja-JP-u-ca-japanese","th-TH-u-nu-thai"]) candidates.push(l);
const out = {};
for (const C of ["Segmenter","Collator","NumberFormat","DateTimeFormat","PluralRules","ListFormat","RelativeTimeFormat","DisplayNames"]) out[C] = Intl[C].supportedLocalesOf(candidates);
out.resolved = [new Intl.Segmenter().resolvedOptions().locale, new Intl.Collator("iw").resolvedOptions().locale, new Intl.NumberFormat("en-US-POSIX").resolvedOptions().locale, new Intl.DateTimeFormat("sr-Latn").resolvedOptions().locale];
console.log(JSON.stringify(out));
