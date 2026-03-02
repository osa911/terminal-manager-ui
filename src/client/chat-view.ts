export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: number;
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'question';
  toolName?: string;
  toolInput?: string;
  collapsed?: boolean;
  questions?: { question: string; options: { label: string; description?: string }[] }[];
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatTimestamp(ts: number): string {
  const date = new Date(ts);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function renderMarkdownBasic(text: string): string {
  let html = escapeHtml(text);

  // Code blocks — extract and replace with placeholders to protect from other transforms
  const codeBlocks: string[] = [];
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => {
    codeBlocks.push(`<pre><code>${code}</code></pre>`);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // Inline code — protect from other transforms
  const inlineCodes: string[] = [];
  html = html.replace(/`([^`]+)`/g, (_m, code) => {
    inlineCodes.push(`<code class="md-inline-code">${code}</code>`);
    return `\x00IC${inlineCodes.length - 1}\x00`;
  });

  // Headers (## Header)
  html = html.replace(/^(#{1,4})\s+(.+)$/gm, (_m, hashes: string, content: string) => {
    const level = hashes.length;
    return `<h${level} class="md-h${level}">${content}</h${level}>`;
  });

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Strikethrough
  html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');

  // Links [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" class="md-link">$1</a>');

  // Unordered lists (- item or * item)
  html = html.replace(/^[\-\*]\s+(.+)$/gm, '<li>$1</li>');
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul class="md-list">$1</ul>');

  // Ordered lists (1. item)
  html = html.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');

  // Horizontal rules
  html = html.replace(/^---+$/gm, '<hr class="md-hr">');

  // Tables — match consecutive lines starting with |
  html = html.replace(/((?:^\|.+\|$\n?)+)/gm, (_m, tableBlock: string) => {
    const rows = tableBlock.trim().split('\n').filter(r => r.trim());
    if (rows.length < 2) return tableBlock;

    const parseRow = (row: string) =>
      row.split('|').slice(1, -1).map(cell => cell.trim());

    // Check if second row is separator (|---|---|)
    const isSeparator = /^\|[\s\-:]+\|/.test(rows[1]);
    if (!isSeparator) return tableBlock;

    const headerCells = parseRow(rows[0]);
    const bodyRows = rows.slice(2);

    let table = '<table class="md-table"><thead><tr>';
    for (const cell of headerCells) {
      table += `<th>${cell}</th>`;
    }
    table += '</tr></thead><tbody>';
    for (const row of bodyRows) {
      table += '<tr>';
      for (const cell of parseRow(row)) {
        table += `<td>${cell}</td>`;
      }
      table += '</tr>';
    }
    table += '</tbody></table>';
    return table;
  });

  // Restore code blocks and inline codes
  html = html.replace(/\x00CB(\d+)\x00/g, (_m, i) => codeBlocks[parseInt(i)]);
  html = html.replace(/\x00IC(\d+)\x00/g, (_m, i) => inlineCodes[parseInt(i)]);

  // Line breaks (but not inside pre/ul/ol)
  html = html.replace(/\n/g, '<br>');

  return html;
}

export function renderChatMessage(msg: ChatMessage): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = `chat-message ${msg.role}`;
  wrapper.dataset.messageId = msg.id;

  if (msg.type === 'thinking') {
    wrapper.innerHTML = renderCollapsible('Thinking...', msg.content, msg.collapsed !== false);
    return wrapper;
  }

  if (msg.type === 'tool_use') {
    const label = `Tool: ${msg.toolName || 'unknown'}`;
    const content = msg.toolInput || '';
    wrapper.innerHTML = renderCollapsible(label, content, msg.collapsed !== false);
    return wrapper;
  }

  if (msg.type === 'tool_result') {
    wrapper.innerHTML = renderCollapsible('Tool Result', msg.content, msg.collapsed !== false);
    return wrapper;
  }

  if (msg.type === 'question' && msg.questions) {
    wrapper.classList.add('question');
    for (const q of msg.questions) {
      const questionText = document.createElement('div');
      questionText.className = 'chat-bubble question-bubble';
      questionText.innerHTML = `<div class="question-text">${escapeHtml(q.question)}</div>`;

      const optionsDiv = document.createElement('div');
      optionsDiv.className = 'question-options';
      for (const opt of q.options) {
        const btn = document.createElement('button');
        btn.className = 'btn-question-option';
        btn.innerHTML = `<span class="option-label">${escapeHtml(opt.label)}</span>${opt.description ? `<span class="option-desc">${escapeHtml(opt.description)}</span>` : ''}`;
        btn.addEventListener('click', () => {
          if (onAnswerCallback) onAnswerCallback(opt.label);
        });
        optionsDiv.appendChild(btn);
      }
      questionText.appendChild(optionsDiv);
      wrapper.appendChild(questionText);
    }

    const meta = document.createElement('div');
    meta.className = 'chat-meta';
    meta.textContent = formatTimestamp(msg.timestamp);
    wrapper.appendChild(meta);
    return wrapper;
  }

  // Regular text message
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';
  bubble.innerHTML = msg.role === 'assistant' ? renderMarkdownBasic(msg.content) : escapeHtml(msg.content);

  const meta = document.createElement('div');
  meta.className = 'chat-meta';
  meta.textContent = formatTimestamp(msg.timestamp);

  wrapper.appendChild(bubble);
  wrapper.appendChild(meta);

  return wrapper;
}

let onAnswerCallback: ((answer: string) => void) | null = null;

export function setOnAnswerCallback(cb: (answer: string) => void): void {
  onAnswerCallback = cb;
}

function renderCollapsible(title: string, content: string, collapsed: boolean): string {
  const arrowClass = collapsed ? 'collapsible-arrow' : 'collapsible-arrow open';
  const contentClass = collapsed ? 'collapsible-content' : 'collapsible-content open';
  return `
    <div class="collapsible-header" onclick="this.querySelector('.collapsible-arrow').classList.toggle('open');this.nextElementSibling.classList.toggle('open')">
      <span class="${arrowClass}">&#9654;</span>
      <span>${escapeHtml(title)}</span>
    </div>
    <div class="${contentClass}">${escapeHtml(content)}</div>
  `;
}

export class ChatView {
  private container: HTMLElement;
  private messages: ChatMessage[] = [];

  constructor(containerId: string) {
    this.container = document.getElementById(containerId)!;
  }

  clear(): void {
    this.messages = [];
    this.container.innerHTML = '';
  }

  setMessages(messages: ChatMessage[]): void {
    this.clear();
    this.messages = messages;
    const fragment = document.createDocumentFragment();
    for (const msg of messages) {
      fragment.appendChild(renderChatMessage(msg));
    }
    this.container.appendChild(fragment);
    this.scrollToBottom();
  }

  appendMessage(msg: ChatMessage): void {
    this.messages.push(msg);
    this.container.appendChild(renderChatMessage(msg));
    this.scrollToBottom();
  }

  private scrollToBottom(): void {
    const parent = this.container.parentElement;
    if (parent) {
      parent.scrollTop = parent.scrollHeight;
    }
  }
}
