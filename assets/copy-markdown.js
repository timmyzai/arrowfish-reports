(function () {
  'use strict';

  var RESET_DELAY_MS = 2200;
  var BLOCK_TAGS = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DETAILS', 'DIV', 'DL', 'FIELDSET',
    'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'HEADER', 'HR', 'MAIN', 'NAV', 'OL',
    'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'UL'
  ]);
  var SKIP_SELECTOR = [
    'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'form', 'button',
    'input', 'select', 'textarea', '#auth-gate', '.page-nav', '.footer',
    '.report-footer', '[data-copy-markdown-ignore]'
  ].join(',');

  var frame;
  var button;
  var label;
  var status;
  var resetTimer;

  function t(key) {
    return window.ArrowfishI18n ? window.ArrowfishI18n.t(key) : key;
  }

  function init() {
    frame = document.getElementById('report-frame');
    button = document.getElementById('copy-markdown-button');
    status = document.getElementById('copy-markdown-status');
    if (!frame || !button || !status) return;

    label = button.querySelector('.copy-markdown-label');
    button.addEventListener('click', copySelectedReport);
    frame.addEventListener('load', updateAvailability);

    new MutationObserver(function (mutations) {
      if (!mutations.some(function (mutation) { return mutation.attributeName === 'src'; })) return;
      clearResetTimer();
      setState('loading', t('copy.action'), t('copy.loading'));
    }).observe(frame, { attributes: true, attributeFilter: ['src'] });

    updateAvailability();
    window.addEventListener('arrowfish:preferenceschange', function () {
      setState('loading', t('copy.action'), t('copy.loading'));
      window.setTimeout(updateAvailability, 0);
    });
  }

  function getReportRoot(reportDocument) {
    return reportDocument && (
      reportDocument.querySelector('main') ||
      reportDocument.querySelector('.container') ||
      reportDocument.body
    );
  }

  async function updateAvailability() {
    clearResetTimer();
    try {
      var reportDocument = frame.contentDocument;
      if (reportDocument && reportDocument.documentElement.classList.contains('i18n-pending')) {
        await new Promise(function (resolve) {
          var observer = new MutationObserver(function () {
            if (reportDocument.documentElement.classList.contains('i18n-pending')) return;
            observer.disconnect();
            resolve();
          });
          observer.observe(reportDocument.documentElement, { attributes: true, attributeFilter: ['class'] });
          window.setTimeout(function () { observer.disconnect(); resolve(); }, 10000);
        });
      }
      var root = getReportRoot(reportDocument);
      if (!root || !root.textContent.trim()) throw new Error(t('copy.reportUnavailable'));
      setState('idle', t('copy.action'), t('copy.ready'));
    } catch (error) {
      setState('loading', t('copy.action'), t('copy.unavailable'));
    }
  }

  async function copySelectedReport() {
    if (button.disabled) return;
    clearResetTimer();

    try {
      if (!window.isSecureContext || !navigator.clipboard || !navigator.clipboard.writeText) {
        throw new Error(t('copy.secureContext'));
      }

      var reportDocument = frame.contentDocument;
      var root = getReportRoot(reportDocument);
      if (!root) throw new Error(t('copy.reportUnavailable'));

      var markdown = convertRoot(root, reportDocument);
      if (!markdown) throw new Error(t('copy.noContent'));

      await navigator.clipboard.writeText(markdown);
      setState('success', t('copy.done'), t('copy.doneStatus'));
    } catch (error) {
      setState('error', t('copy.failed'), error && error.message ? error.message : t('copy.failedStatus'));
    }

    resetTimer = window.setTimeout(updateAvailability, RESET_DELAY_MS);
  }

  function setState(state, text, message) {
    button.dataset.state = state;
    button.disabled = state === 'loading';
    label.textContent = text;
    status.textContent = message;
  }

  function clearResetTimer() {
    if (!resetTimer) return;
    window.clearTimeout(resetTimer);
    resetTimer = null;
  }

  function convertRoot(root, reportDocument) {
    return normalizeMarkdown(renderChildren(root, {
      document: reportDocument,
      listDepth: 0
    }));
  }

  function renderNode(node, context) {
    if (node.nodeType === Node.TEXT_NODE) return normalizeText(node.nodeValue);
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    var element = node;
    var tag = element.tagName;
    if (element.matches(SKIP_SELECTOR)) return '';

    if (/^H[1-6]$/.test(tag)) {
      return repeat('#', Number(tag.slice(1))) + ' ' + normalizeInline(renderChildren(element, context));
    }

    switch (tag) {
      case 'BR':
        return '<br>';
      case 'HR':
        return '---';
      case 'P':
        return normalizeInline(renderChildren(element, context));
      case 'STRONG':
      case 'B':
        return wrapInline(renderChildren(element, context), '**');
      case 'EM':
      case 'I':
        return wrapInline(renderChildren(element, context), '_');
      case 'DEL':
      case 'S':
        return wrapInline(renderChildren(element, context), '~~');
      case 'CODE':
        if (element.parentElement && element.parentElement.tagName === 'PRE') return element.textContent;
        return renderInlineCode(element.textContent);
      case 'PRE':
        return renderCodeBlock(element);
      case 'A':
        return renderLink(element, context);
      case 'IMG':
        return renderImage(element, context.document);
      case 'BLOCKQUOTE':
        return prefixLines(normalizeMarkdown(renderChildren(element, context)), '> ');
      case 'UL':
        return renderList(element, false, context);
      case 'OL':
        return renderList(element, true, context);
      case 'LI':
        return normalizeMarkdown(renderChildren(element, context));
      case 'TABLE':
        return renderTable(element, context);
      case 'DT':
        return wrapInline(renderChildren(element, context), '**');
      case 'DD':
        return ': ' + normalizeInline(renderChildren(element, context));
      default:
        return renderChildren(element, context);
    }
  }

  function renderChildren(element, context) {
    var output = '';
    Array.from(element.childNodes).forEach(function (child) {
      var part = renderNode(child, context);
      if (!part) return;

      if (isBlockNode(child)) {
        output = output.replace(/[ \t]+$/g, '').replace(/\n?$/g, '\n\n');
        output += part.trim() + '\n\n';
      } else {
        output += part;
      }
    });
    return output;
  }

  function isBlockNode(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    if (BLOCK_TAGS.has(node.tagName) || /^H[1-6]$/.test(node.tagName)) return true;
    try {
      var display = node.ownerDocument.defaultView.getComputedStyle(node).display;
      return display === 'block' || display === 'flex' || display === 'grid' ||
        display === 'table' || display === 'list-item';
    } catch (error) {
      return false;
    }
  }

  function renderList(list, ordered, context) {
    var start = ordered ? Number(list.getAttribute('start') || 1) : 1;
    var depth = context.listDepth || 0;
    var indent = repeat('    ', depth);
    var lines = [];

    Array.from(list.children).forEach(function (item, itemIndex) {
      if (item.tagName !== 'LI') return;
      var nestedLists = Array.from(item.children).filter(function (child) {
        return child.tagName === 'UL' || child.tagName === 'OL';
      });
      var bodyParts = Array.from(item.childNodes).filter(function (child) {
        return !(child.nodeType === Node.ELEMENT_NODE && (child.tagName === 'UL' || child.tagName === 'OL'));
      }).map(function (child) {
        return renderNode(child, Object.assign({}, context, { listDepth: depth }));
      });
      var bodyLines = normalizeMarkdown(bodyParts.join('')).split('\n');
      var itemNumber = item.hasAttribute('value') ? Number(item.getAttribute('value')) : start + itemIndex;
      var marker = ordered ? itemNumber + '. ' : '- ';
      var continuation = indent + repeat(' ', marker.length);

      lines.push(indent + marker + (bodyLines.shift() || ''));
      bodyLines.forEach(function (line) {
        if (line) lines.push(continuation + line);
      });

      nestedLists.forEach(function (nestedList) {
        lines.push(renderList(nestedList, nestedList.tagName === 'OL', Object.assign({}, context, {
          listDepth: depth + 1
        })));
      });
    });

    return lines.join('\n');
  }

  function renderTable(table, context) {
    var rows = Array.from(table.querySelectorAll('tr')).filter(function (row) {
      return row.closest('table') === table;
    });
    if (!rows.length) return '';

    var parsedRows = rows.map(function (row) {
      var cells = Array.from(row.children).filter(function (cell) {
        return cell.tagName === 'TH' || cell.tagName === 'TD';
      });
      var values = [];
      cells.forEach(function (cell) {
        var value = normalizeTableCell(renderChildren(cell, context));
        var span = Math.max(1, Number(cell.getAttribute('colspan') || 1));
        values.push(value);
        while (span > 1) {
          values.push('');
          span -= 1;
        }
      });
      return {
        values: values,
        header: cells.some(function (cell) { return cell.tagName === 'TH'; }),
        group: cells.length === 1 && Number(cells[0].getAttribute('colspan') || 1) > 1
      };
    });

    var columnCount = parsedRows.reduce(function (maximum, row) {
      return Math.max(maximum, row.values.length);
    }, 0);
    if (!columnCount) return '';

    parsedRows.forEach(function (row) {
      while (row.values.length < columnCount) row.values.push('');
    });

    var headerIndex = parsedRows.findIndex(function (row) { return row.header && !row.group; });
    var header = headerIndex >= 0 ? parsedRows[headerIndex].values : new Array(columnCount).fill('');
    var body = parsedRows.filter(function (row, index) { return index !== headerIndex; });
    var markdownRows = [renderTableRow(header), renderTableRow(new Array(columnCount).fill('---'))];

    body.forEach(function (row) {
      if (row.group) row.values[0] = row.values[0] ? '**' + row.values[0] + '**' : '';
      markdownRows.push(renderTableRow(row.values));
    });

    return markdownRows.join('\n');
  }

  function renderTableRow(values) {
    return '| ' + values.map(function (value) { return value || ' '; }).join(' | ') + ' |';
  }

  function normalizeTableCell(value) {
    return normalizeMarkdown(value)
      .replace(/\|/g, '\\|')
      .replace(/\n+/g, '<br>')
      .trim();
  }

  function renderLink(link, context) {
    var text = normalizeInline(renderChildren(link, context)) || link.getAttribute('aria-label') || '';
    var rawHref = link.getAttribute('href');
    if (!rawHref || /^javascript:/i.test(rawHref)) return text;
    var href = resolveUrl(rawHref, context.document);
    var title = link.getAttribute('title');
    return '[' + text + '](' + href + (title ? ' "' + title.replace(/"/g, '\\"') + '"' : '') + ')';
  }

  function renderImage(image, reportDocument) {
    var rawSource = image.getAttribute('src');
    if (!rawSource) return '';
    var alt = escapeMarkdown(image.getAttribute('alt') || '');
    var title = image.getAttribute('title');
    return '![' + alt + '](' + resolveUrl(rawSource, reportDocument) +
      (title ? ' "' + title.replace(/"/g, '\\"') + '"' : '') + ')';
  }

  function resolveUrl(value, reportDocument) {
    if (value.charAt(0) === '#') return value;
    try { return new URL(value, reportDocument.baseURI).href; }
    catch (error) { return value; }
  }

  function renderCodeBlock(pre) {
    var code = pre.querySelector('code');
    var value = (code || pre).textContent.replace(/^\n|\n$/g, '');
    var languageMatch = code && code.className.match(/(?:^|\s)language-([\w-]+)/);
    var language = languageMatch ? languageMatch[1] : '';
    var fence = repeat('`', Math.max(3, longestRun(value, '`') + 1));
    return fence + language + '\n' + value + '\n' + fence;
  }

  function renderInlineCode(value) {
    var fence = repeat('`', Math.max(1, longestRun(value, '`') + 1));
    var padding = /^`|`$|^\s|\s$/.test(value) ? ' ' : '';
    return fence + padding + value + padding + fence;
  }

  function longestRun(value, character) {
    var pattern = new RegExp(escapeRegExp(character) + '+', 'g');
    return (value.match(pattern) || []).reduce(function (length, run) {
      return Math.max(length, run.length);
    }, 0);
  }

  function wrapInline(value, marker) {
    var content = normalizeInline(value);
    return content ? marker + content + marker : '';
  }

  function normalizeText(value) {
    return escapeMarkdown(String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' '));
  }

  function escapeMarkdown(value) {
    return value.replace(/([\\`*_[\]<>])/g, '\\$1');
  }

  function normalizeInline(value) {
    return String(value || '')
      .replace(/[ \t]*\n+[ \t]*/g, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  function normalizeMarkdown(value) {
    return String(value || '')
      .split('\n')
      .map(function (line) { return line.replace(/[ \t]+$/g, ''); })
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function prefixLines(value, prefix) {
    return value.split('\n').map(function (line) { return prefix + line; }).join('\n');
  }

  function repeat(value, count) {
    return new Array(count + 1).join(value);
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
