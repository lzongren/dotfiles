import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import makefile from 'highlight.js/lib/languages/makefile'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import ruby from 'highlight.js/lib/languages/ruby'
import rust from 'highlight.js/lib/languages/rust'
import scala from 'highlight.js/lib/languages/scala'
import sql from 'highlight.js/lib/languages/sql'
import swift from 'highlight.js/lib/languages/swift'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

const LANGUAGES = { bash, c, cpp, csharp, css, diff, dockerfile, go, ini, java, javascript, json, kotlin, makefile, markdown, python, ruby, rust, scala, sql, swift, typescript, xml, yaml }
for (const [name, language] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, language)

const BY_EXTENSION: Record<string, string> = {
  sh: 'bash', bash: 'bash', zsh: 'bash', h: 'c', hpp: 'cpp', cc: 'cpp', cs: 'csharp', patch: 'diff',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', mts: 'typescript',
  excalidraw: 'json', jsonl: 'json', kt: 'kotlin', kts: 'kotlin', mk: 'makefile', md: 'markdown', py: 'python', rb: 'ruby', rs: 'rust',
  toml: 'ini', cfg: 'ini', conf: 'ini', yml: 'yaml', html: 'xml', htm: 'xml', svg: 'xml', smithy: 'java',
}
const BY_NAME: Record<string, string> = { Dockerfile: 'dockerfile', Makefile: 'makefile', makefile: 'makefile' }
const MAX = 512 * 1024

export function languageOf(file: string): string | null {
  const name = file.slice(file.lastIndexOf('/') + 1)
  if (BY_NAME[name]) return BY_NAME[name]
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
  const lang = BY_EXTENSION[ext] ?? ext
  return hljs.getLanguage(lang) ? lang : null
}

export function highlight(text: string, language: string | null): string | null {
  if (!language || text.length > MAX || !hljs.getLanguage(language)) return null
  return hljs.highlight(text, { language, ignoreIllegals: true }).value
}
