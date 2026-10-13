import { describe, expect, it } from 'vitest'
import { highlight, languageOf } from '../../src/highlight'
import { renderMarkdown, resolvePath } from '../../src/markdown'

const render = (text: string) => renderMarkdown(text, '/home/me/work/api/docs/plan.md')

describe('markdown rendering', () => {
  it('escapes raw HTML instead of passing it through', () => {
    const html = render('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>')
    expect(html).not.toMatch(/<script|<img/)
    expect(html).toContain('&lt;script&gt;')
  })

  it('never links script or file URLs', () => {
    const html = render('[a](javascript:alert(1)) [b](vbscript:x) [c](file:///etc/passwd) [d](data:text/html,x)')
    expect(html).not.toMatch(/href="(javascript|vbscript|file|data):/i)
  })

  it('opens web links in a new tab without handing over the page', () => {
    expect(render('[pr](https://github.com/o/r/pull/1) and https://example.com')).toMatch(
      /<a href="https:\/\/github.com\/o\/r\/pull\/1" target="_blank" rel="noopener noreferrer">pr<\/a>.*<a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer">/,
    )
  })

  it('turns links to other files into in-preview links resolved against the file folder', () => {
    const html = render('[spec](../spec.md) [deep](./notes/a%20b.md#part) [abs](/tmp/x.txt)')
    expect(html).toContain('<a data-path="/home/me/work/api/spec.md" role="link" tabindex="0">spec</a>')
    expect(html).not.toContain('href="#"')
    expect(html).toContain('data-path="/home/me/work/api/docs/notes/a b.md"')
    expect(html).toContain('data-path="/tmp/x.txt"')
  })

  it('gives headings ids and turns #links into in-page jumps, without touching the page URL', () => {
    const html = render('# Open questions\n\n## Open questions\n\n[jump](#open-questions)')
    expect(html).toContain('<h1 id="md-open-questions" tabindex="-1">')
    expect(html).toContain('<h2 id="md-open-questions-1" tabindex="-1">')
    expect(html).toContain('<a data-anchor="md-open-questions" role="link" tabindex="0">jump</a>')
    const ids = [...render('## Setup & Install_now\n## _Draft_ plan\n## See [docs](https://x.io)\n## Q&amp;A\n## The `foo` option\n\nFoo\nbar\n===').matchAll(/id="([^"]+)"/g)].map((m) => m[1])
    expect(ids).toEqual(['md-setup--install_now', 'md-draft-plan', 'md-see-docs', 'md-qa', 'md-the-foo-option', 'md-foo-bar'])
  })

  it('survives malformed escapes and leaves bare file names as text', () => {
    expect(render('[a](#%E0%A4) [b](x%E0%A4.md)')).toMatch(/data-anchor="md-e0a4".*data-path="\/home\/me\/work\/api\/docs\/x%E0%A4.md"/)
    const html = render('see README.md, setup.py, Ghostty.app, logo.ai and https://example.com, not www.example.com')
    expect([...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1])).toEqual(['https://example.com'])
    expect(render('[ftp](ftp://h/x)')).toContain('<p><span>ftp</span></p>')
    const self = render('[setup](plan.md#setup) [same](./plan.md) [there](spec.md#intro)')
    expect(self).toContain('<a data-anchor="md-setup" role="link" tabindex="0">setup</a>')
    expect(self).toContain('<a data-path="/home/me/work/api/docs/plan.md" role="link" tabindex="0">same</a>')
    expect(self).toContain('<a data-path="/home/me/work/api/docs/spec.md" role="link" tabindex="0">there</a>')
  })

  it('shows images it cannot load as links, and keeps inline data images', () => {
    const html = render('![chart](chart.png) ![remote](https://example.com/a.png) ![dot](data:image/png;base64,AAAA) ![odd](ftp://h/a.png)')
    expect(html).toContain('<a class="md-image" data-path="/home/me/work/api/docs/chart.png" role="link" tabindex="0">image: chart</a>')
    expect(html).toContain('<span class="md-image">image: odd</span>')
    expect(html).toContain('<a href="https://example.com/a.png" class="md-image" target="_blank" rel="noopener noreferrer">image: remote</a>')
    expect(html).toContain('<img src="data:image/png;base64,AAAA" alt="dot">')
  })

  it('renders task lists as checkboxes, tables, and highlighted code that keyboard users can scroll', () => {
    const html = render('- [ ] todo\n- [x] done\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = "y"\n```')
    expect(html).toContain('<li class="md-task"><label><input type="checkbox" disabled> todo</label></li>')
    expect(html).toContain('<li class="md-task"><label><input type="checkbox" disabled checked> done</label></li>')
    expect(render('- \\[ \\] escaped\n- [x]\ttabbed')).toMatch(/<li>\[ \] escaped<\/li>\n<li class="md-task"><label><input type="checkbox" disabled checked> tabbed/)
    expect(render('- [ ] loose\n\n  more\n- not [ ] a task')).toMatch(/<li class="md-task">\s*<p><label><input type="checkbox" disabled> loose<\/label><\/p>[\s\S]*<li>\s*<p>not \[ \] a task<\/p>/)
    expect(html).toContain('<table tabindex="0">')
    expect(html).toMatch(/<pre tabindex="0"><code class="language-ts"><span class="hljs-keyword">const<\/span>/)
  })

  it('resolves dot segments without climbing above the root', () => {
    expect(resolvePath('/a/b', '../../../c')).toBe('/c')
    expect(resolvePath('/a/b', './c/../d')).toBe('/a/b/d')
  })
})

describe('code highlighting', () => {
  it('picks the language from the file name and leaves unknown or huge files plain', () => {
    expect(languageOf('/w/app.py')).toBe('python')
    expect(languageOf('/w/Dockerfile')).toBe('dockerfile')
    expect(languageOf('/w/notes.unknownext')).toBeNull()
    expect(highlight('x'.repeat(600 * 1024), 'python')).toBeNull()
    expect(highlight('<b>"x"</b>', 'xml')).not.toContain('<b>')
    for (const name of ['/w/constructor', '/w/a.__proto__', '/w/x.toString']) expect(languageOf(name)).toBeNull()
  })
})
