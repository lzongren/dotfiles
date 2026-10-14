import MarkdownIt from 'markdown-it'
import { highlight } from './highlight'

interface Env {
  file: string
  dir: string
  ids: Set<string>
  tables: number
}

const md = new MarkdownIt({ html: false, linkify: true, highlight: (code, lang) => highlight(code, lang.trim().split(/\s+/)[0] || null) ?? '' })
md.linkify.set({ fuzzyLink: false })
type Token = ReturnType<MarkdownIt['parse']>[number]
const EXTERNAL = /^(https?:|mailto:)/i
const internal = (name: string, value: string): Array<[string, string]> => [
  [name, value],
  ['role', 'link'],
  ['tabindex', '0'],
]

export function slug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-')
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

export function resolvePath(dir: string, ref: string): string {
  const parts = (ref.startsWith('/') ? ref : `${dir}/${ref}`).split('/')
  const out: string[] = []
  for (const part of parts) {
    if (part === '..') out.pop()
    else if (part && part !== '.') out.push(part)
  }
  return `/${out.join('/')}`
}

function local(href: string, env: Env): string | null {
  const bare = href.split(/[?#]/)[0]
  if (!bare || /^\/\/[^/]/.test(bare) || /^[a-z][a-z0-9+.-]*:/i.test(bare)) return null
  return resolvePath(env.dir, decode(bare))
}

md.core.ruler.before('text_join', 'tasks', (state) => {
  const tokens = state.tokens
  for (let i = 2; i < tokens.length; i++) {
    const children = tokens[i].children
    const mark = children?.[0]?.type === 'text' ? /^\[([ xX])\][ \t]/.exec(children[0].content) : null
    if (!children || !mark || tokens[i - 1].type !== 'paragraph_open' || tokens[i - 2].type !== 'list_item_open') continue
    children[0].content = children[0].content.slice(mark[0].length)
    tokens[i - 2].attrSet('class', 'md-task')
    const open = new state.Token('html_inline', '', 0)
    open.content = `<label><input type="checkbox" disabled${mark[1] === ' ' ? '' : ' checked'}> `
    const close = new state.Token('html_inline', '', 0)
    close.content = '</label>'
    children.unshift(open)
    children.push(close)
  }
  return true
})

md.renderer.rules.heading_open = (tokens, i, options, env: Env, self) => {
  const text = (tokens[i + 1]?.children ?? [])
    .map((t) => (t.type === 'text' || t.type === 'code_inline' ? t.content : t.type.endsWith('break') ? ' ' : ''))
    .join('')
  const base = `md-${slug(text)}`
  let id = base
  for (let n = 1; env.ids.has(id); n++) id = `${base}-${n}`
  env.ids.add(id)
  tokens[i].attrSet('id', id)
  tokens[i].attrSet('tabindex', '-1')
  return self.renderToken(tokens, i, options)
}

md.renderer.rules.link_open = (tokens, i, options, env: Env, self) => {
  const token = tokens[i]
  const href = token.attrGet('href') ?? ''
  if (EXTERNAL.test(href)) {
    token.attrSet('target', '_blank')
    token.attrSet('rel', 'noopener noreferrer')
    return self.renderToken(tokens, i, options)
  }
  const path = href.startsWith('#') ? env.file : local(href, env)
  const hash = href.indexOf('#')
  const anchor = path === env.file && hash >= 0 ? slug(decode(href.slice(hash + 1))) : ''
  token.attrs = (token.attrs ?? []).filter(([name]) => name !== 'href')
  if (anchor) token.attrs.push(...internal('data-anchor', `md-${anchor}`))
  else if (path && path !== env.file) token.attrs.push(...internal('data-path', path))
  else {
    token.tag = 'span'
    let close = i + 1
    while (close < tokens.length && tokens[close].type !== 'link_close') close++
    if (close < tokens.length) tokens[close].tag = 'span'
  }
  return self.renderToken(tokens, i, options)
}

md.renderer.rules.table_open = (_tokens, _i, _options, env: Env) => `<div class="md-table" role="region" aria-label="table ${++env.tables}" tabindex="0"><table>\n`
md.renderer.rules.table_close = () => '</table>\n</div>\n'

const image = md.renderer.rules.image!
md.renderer.rules.image = (tokens: Token[], i, options, env: Env, self) => {
  const token = tokens[i]
  const src = token.attrGet('src') ?? ''
  if (/^data:image\//i.test(src)) return image(tokens, i, options, env, self)
  const alt = md.utils.escapeHtml(self.renderInlineAsText(token.children ?? [], options, env) || src)
  let before = i - 1
  while (before >= 0 && tokens[before].type !== 'link_open' && tokens[before].type !== 'link_close') before--
  if (before >= 0 && tokens[before].type === 'link_open' && tokens[before].tag === 'a') return `<span class="md-image">image: ${alt}</span>`
  const path = local(src, env)
  if (path) return `<a class="md-image" data-path="${md.utils.escapeHtml(path)}" role="link" tabindex="0">image: ${alt}</a>`
  if (!EXTERNAL.test(src)) return `<span class="md-image">image: ${alt}</span>`
  return `<a href="${md.utils.escapeHtml(src)}" class="md-image" target="_blank" rel="noopener noreferrer">image: ${alt}</a>`
}

export function renderMarkdown(text: string, file: string): string {
  const at = resolvePath('/', file)
  const env: Env = { file: at, dir: at.slice(0, at.lastIndexOf('/')) || '/', ids: new Set(), tables: 0 }
  return md.render(text, env).replace(/<pre>/g, '<pre tabindex="0">')
}
