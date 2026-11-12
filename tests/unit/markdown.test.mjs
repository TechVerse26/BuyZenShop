/* Product descriptions and CMS pages are written by staff and shown to every visitor, so the Markdown renderer is a security boundary:
 * whatever is stored, the output may only contain the handful of tags it generates itself. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, stripMarkdown } from '../../js/shared/markdown.js';

const ALLOWED_TAG = /<\/?(p|h[2-4]|ul|ol|li|blockquote|strong|em|code|br|hr)>|<a href="[^"<>]*" target="_blank" rel="noopener noreferrer">|<\/a>/g;

/** The output with every tag the renderer is allowed to produce removed — nothing angle-bracketed may be left. */
const leftovers = (html) => html.replace(ALLOWED_TAG, '');

test('headings shift down one level (the page title is the only h1), lists and quotes and rules render', () => {
  const html = renderMarkdown('# Title\n## Sub\n### Third\n#### Four hashes are just text\n\n- a\n- b\n\n1. one\n2) two\n\n> quote\n\n---');
  assert.match(html, /<h2>Title<\/h2>/);
  assert.match(html, /<h3>Sub<\/h3>/);
  assert.match(html, /<h4>Third<\/h4>/);
  assert.doesNotMatch(html, /<h5>/);
  assert.match(html, /<ul>\n<li>a<\/li>\n<li>b<\/li>\n<\/ul>/);
  assert.match(html, /<ol>\n<li>one<\/li>\n<li>two<\/li>\n<\/ol>/);
  assert.match(html, /<blockquote>quote<\/blockquote>/);
  assert.match(html, /<hr>/);
});

test('inline styles: bold, italic, code (whose content is shown literally)', () => {
  assert.equal(renderMarkdown('Hello **bold** and *it* and `<b>x</b>`'), '<p>Hello <strong>bold</strong> and <em>it</em> and <code>&lt;b&gt;x&lt;/b&gt;</code></p>');
});

test('line breaks inside a paragraph, blank lines between paragraphs, Windows line endings', () => {
  assert.equal(renderMarkdown('one\ntwo\n\nthree'), '<p>one<br>two</p>\n<p>three</p>');
  assert.equal(renderMarkdown('one\r\ntwo\r\n\r\nthree'), '<p>one<br>two</p>\n<p>three</p>');
  assert.equal(renderMarkdown(''), '');
  assert.equal(renderMarkdown(null), '');
  assert.equal(renderMarkdown('   \n  '), '');
});

test('a list closes before the next paragraph and switches kind cleanly', () => {
  assert.equal(renderMarkdown('- a\ntext'), '<ul>\n<li>a</li>\n</ul>\n<p>text</p>');
  assert.equal(renderMarkdown('- a\n1. b'), '<ul>\n<li>a</li>\n</ul>\n<ol>\n<li>b</li>\n</ol>');
});

test('links: only http(s), mailto and tel are linked, always with rel="noopener noreferrer"', () => {
  const html = renderMarkdown('[shop](https://example.com/a?b=1&c=2) [mail](mailto:a@b.co) [call](tel:+8801712345678) [up](HTTPS://EX.COM)');
  assert.equal((html.match(/<a /g) || []).length, 4);
  assert.match(html, /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">shop<\/a>/);
  assert.match(html, /<a href="mailto:a@b\.co"/);
  assert.match(html, /<a href="tel:\+8801712345678"/);
  assert.equal(leftovers(html).replace(/&amp;|[^<>]/g, ''), '', 'no stray angle brackets');
});

test('hostile content never produces a tag or an attribute of its own', () => {
  const evil = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<iframe src="https://evil.example"></iframe>',
    '# <svg onload=alert(1)>',
    '**<b onclick=x>bold</b>**',
    '`</code><script>alert(1)</script>`',
    '- <a href="javascript:alert(1)">x</a>',
    '> <style>*{display:none}</style>',
    '[a](javascript:alert(1))',
    '[a](JaVaScRiPt:alert(1))',
    '[a](&#106;avascript:alert(1))',
    '[a](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
    '[a](vbscript:msgbox(1))',
    '[a]( javascript:alert(1))',
    '[a](https://x.com/" onmouseover="alert(1))',
    '[a](https://x.com/"onmouseover="alert(1))',
    "[a](https://x.com/'onmouseover='alert(1))",
    '[<img src=x onerror=alert(1)>](https://a.com)',
    '[a](https://a.com/<script>alert(1)</script>)',
    '[a](//evil.example/x) [b](/relative) [c](ftp://x.y/z) [d](file:///etc/passwd)',
  ];
  for (const src of evil) {
    const html = renderMarkdown(src);
    assert.equal(leftovers(html).match(/[<>]/g), null, `${src}\n→ ${html}`);
    assert.doesNotMatch(html, /href="(?!https?:|mailto:|tel:)/i, `bad href in: ${html}`);
    assert.doesNotMatch(html, /<a [^>]*\son\w+=/i, `event handler on a link: ${html}`);
    // every attribute value is closed by the very quote that opened it, so nothing can escape the href
    for (const a of html.match(/<a [^>]*>/g) || []) assert.match(a, /^<a href="[^"<>]*" target="_blank" rel="noopener noreferrer">$/, a);
  }
});

test('"javascript:" links keep their label as plain text', () => {
  const html = renderMarkdown('[click me](javascript:alert(1))');
  assert.doesNotMatch(html, /<a /);
  assert.match(html, /click me/);
});

test('plain-text excerpts for cards and meta descriptions', () => {
  assert.equal(stripMarkdown('# Hi **there** [link](http://a.b) - ok > q'), 'Hi there link ok q');
  assert.equal(stripMarkdown(null), '');
  const long = stripMarkdown('x'.repeat(300), 20);
  assert.equal(long.length, 20);
  assert.ok(long.endsWith('…'));
  assert.equal(stripMarkdown('short', 20), 'short');
});
