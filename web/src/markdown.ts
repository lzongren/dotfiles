import MarkdownIt from 'markdown-it'
import { highlight } from './highlight'

interface Env {
  dir: string
  slugs: Map<string, number>
}

const md = new MarkdownIt({ html: false, linkify: true, highlight: (code, lang) => highlight(code, lang.trim().split(/\s+/)[0] || null) ?? '' })
md.linkify.tlds(['com', 'org', 'net', 'edu', 'gov', 'io', 'dev', 'app', 'ai'])
type Token = ReturnType<MarkdownIt['parse']>[number]
const EXTERNAL = /^(https?:|mailto:)/i
const INTERNAL: Array<[string, string]> = [
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
  if (!bare || /^[a-z][a-z0-9+.-]*:/i.test(bare)) return null
  return resolvePath(env.dir, decode(bare))
}

md.core.ruler.push('tasks', (state) => {
  const tokens = state.tokens
  for (let i = 2; i < tokens.length; i++) {
    const children = tokens[i].children
    const mark = children?.[0]?.type === 'text' ? /^\[([ xX])\] /.exec(children[0].content) : null
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
  const text = (tokens[i + 1]?.children ?? []).map((t) => (t.type === 'text' || t.type === 'code_inline' ? t.content : '')).join('')
  const base = `md-${slug(text)}`
  const seen = env.slugs.get(base) ?? 0
  env.slugs.set(base, seen + 1)
  tokens[i].attrSet('id', seen ? `${base}-${seen}` : base)
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
  const path = href.startsWith('#') ? null : local(href, env)
  token.attrs = (token.attrs ?? []).filter(([name]) => name !== 'href')
  if (href.startsWith('#')) token.attrs.push(['data-anchor', `md-${slug(decode(href.slice(1)))}`], ...INTERNAL)
  else if (path) token.attrs.push(['data-path', path], ...INTERNAL)
  return self.renderToken(tokens, i, options)
}

const image = md.renderer.rules.image!
md.renderer.rules.image = (tokens: Token[], i, options, env: Env, self) => {
  const token = tokens[i]
  const src = token.attrGet('src') ?? ''
  if (/^data:image\//i.test(src)) return image(tokens, i, options, env, self)
  const alt = md.utils.escapeHtml(self.renderInlineAsText(token.children ?? [], options, env) || src)
  const path = local(src, env)
  if (path) return `<a class="md-image" data-path="${md.utils.escapeHtml(path)}" role="link" tabindex="0">image: ${alt}</a>`
  if (!EXTERNAL.test(src)) return `<span class="md-image">image: ${alt}</span>`
  return `<a href="${md.utils.escapeHtml(src)}" class="md-image" target="_blank" rel="noopener noreferrer">image: ${alt}</a>`
}

export function renderMarkdown(text: string, file: string): string {
  const env: Env = { dir: file.slice(0, file.lastIndexOf('/')) || '/', slugs: new Map() }
  return md.render(text, env).replace(/<(pre|table)>/g, '<$1 tabindex="0">')
}
