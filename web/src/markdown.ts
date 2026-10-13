import MarkdownIt from 'markdown-it'
import { highlight } from './highlight'

interface Env {
  dir: string
  slugs: Map<string, number>
}

const md = new MarkdownIt({ html: false, linkify: true, highlight: (code, lang) => highlight(code, lang.trim().split(/\s+/)[0] || null) ?? '' })
md.linkify.set({ fuzzyLink: false })
type Token = ReturnType<MarkdownIt['parse']>[number]
const EXTERNAL = /^(https?:|mailto:)/i

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

md.renderer.rules.heading_open = (tokens, i, options, env: Env, self) => {
  const base = `md-${slug(tokens[i + 1]?.content ?? '')}`
  const seen = env.slugs.get(base) ?? 0
  env.slugs.set(base, seen + 1)
  tokens[i].attrSet('id', seen ? `${base}-${seen}` : base)
  return self.renderToken(tokens, i, options)
}

md.renderer.rules.link_open = (tokens, i, options, env: Env, self) => {
  const token = tokens[i]
  const href = token.attrGet('href') ?? ''
  if (href.startsWith('#')) {
    token.attrSet('href', '#')
    token.attrSet('data-anchor', `md-${slug(decode(href.slice(1)))}`)
  } else if (EXTERNAL.test(href)) {
    token.attrSet('target', '_blank')
    token.attrSet('rel', 'noopener noreferrer')
  } else {
    const path = local(href, env)
    token.attrSet('href', '#')
    if (path) token.attrSet('data-path', path)
  }
  return self.renderToken(tokens, i, options)
}

const image = md.renderer.rules.image!
md.renderer.rules.image = (tokens: Token[], i, options, env: Env, self) => {
  const token = tokens[i]
  const src = token.attrGet('src') ?? ''
  if (/^data:image\//i.test(src)) return image(tokens, i, options, env, self)
  const alt = md.utils.escapeHtml(self.renderInlineAsText(token.children ?? [], options, env) || src)
  const path = local(src, env)
  if (path) return `<a href="#" class="md-image" data-path="${md.utils.escapeHtml(path)}">image: ${alt}</a>`
  const safe = EXTERNAL.test(src) ? md.utils.escapeHtml(src) : '#'
  return `<a href="${safe}" class="md-image" target="_blank" rel="noopener noreferrer">image: ${alt}</a>`
}

export function renderMarkdown(text: string, file: string): string {
  const env: Env = { dir: file.slice(0, file.lastIndexOf('/')) || '/', slugs: new Map() }
  return md
    .render(text, env)
    .replace(/<(pre|table)>/g, '<$1 tabindex="0">')
    .replace(/<li>(<p>)?\[([ xX])\] /g, (_, p: string | undefined, mark: string) =>
      `<li class="md-task">${p ?? ''}<input type="checkbox" aria-label="task" disabled${mark === ' ' ? '' : ' checked'}> `,
    )
}
