// Dev scratch tool (requires `npm i playwright` + a local Chromium at
// %LOCALAPPDATA%\playwright\chrome-win\chrome.exe). Lists image/art URLs
// found on the osrs-tcg.net homepage - used during early art discovery.
const { chromium } = require('playwright');
const exe = process.env.LOCALAPPDATA + '\\playwright\\chrome-win\\chrome.exe';
const ua = 'Mozilla/5.0 (Windows NT 10.0; Win10; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
(async () => {
  const b = await chromium.launch({ executablePath: exe });
  const ctx = await b.newContext({ userAgent: ua });
  const page = await ctx.newPage();
  const html = (await (await ctx.request.get('https://osrs-tcg.net/')).text());
  const urls = [...new Set(html.match(/https?:\/\/osrs-tcg\.net\/[^"'\s)]+/g) || [])];
  const img = urls.filter((u) => /\.(png|jpe?g|webp|avif)/i.test(u) || /art|img|image|card/i.test(u));
  console.log(img.slice(0, 30).join('\n'));
  console.log('--- total urls:', urls.length);
  await b.close();
})();
