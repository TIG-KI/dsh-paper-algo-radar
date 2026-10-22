/**
 * 客户端（浏览器）bundle —— 手写模块加载器格式，零构建。
 *
 * 槽位组合已实测（需求文档 §6）：
 *   sidebar.panellist → 侧栏入口（label() 成为按钮的 aria-label）
 *   main             → 主内容区整宽页面
 *
 * W0 视图：排行 + 论文列表两个标签页，带加载 / 空库 / 读失败三态与「旧口径」标记。
 * 颜色只用实测可用的宿主 token，不出现任何颜色字面量。
 */
window.__ModuleLoader__.load({
  id: 'dsh-paper-algo-radar',
  factory: (require) => {
    'use strict';

    const module = { exports: {} };

    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useState } = React;

    const BASE = '/paper-algo-radar';
    const VIEW_ID = 'paper-algo-radar';
    const PANEL_ORDER = 66;

    const mono = 'ui-monospace, "Cascadia Mono", Consolas, monospace';

    /**
     * 统一请求：**先看 HTTP 状态，再解析文本**。
     * 直接对 response.json() 会在空 body 上抛 "Unexpected end of JSON input"——
     * 那多半是路由根本没命中（宿主跑着旧版本），错误信息应该指向重启而不是让人猜 JSON。
     */
    async function requestJson(path, init) {
      const res = await fetch(path, init);
      const text = await res.text();
      if (text === '') {
        const where = path.replace(BASE, '');
        throw new Error(
          res.status === 404
            ? `接口 ${where} 没有响应（HTTP 404）。通常是宿主还在运行旧版本的插件，重启应用后再试。`
            : `接口 ${where} 返回了空内容（HTTP ${res.status}）。`
        );
      }
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`接口 ${path.replace(BASE, '')} 返回的不是 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`);
      }
      if (!res.ok) {
        const message = body?.error?.message || body?.error || `HTTP ${res.status}`;
        throw new Error(String(message));
      }
      return body;
    }

    // ── 样式：只用实测 token ────────────────────────────────
    const S = {
      root: {
        height: '100%',
        minHeight: 0,
        overflow: 'auto',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        padding: '22px 26px 40px',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        lineHeight: 1.6,
      },
      top: { display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap' },
      title: { margin: 0, fontSize: 19, fontWeight: 600, letterSpacing: '-0.01em' },
      stats: {
        display: 'flex',
        alignItems: 'baseline',
        gap: 6,
        fontFamily: mono,
        fontSize: 11.5,
        color: 'var(--dsw-alias-label-secondary)',
      },
      statNum: { color: 'var(--dsw-alias-label-primary)', fontWeight: 600, fontSize: 13 },
      spacer: { flex: 1 },
      btn: {
        height: 26,
        padding: '0 10px',
        borderRadius: 'var(--dsw-radius-sm)',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        fontFamily: 'inherit',
        fontSize: 12,
        cursor: 'pointer',
      },
      badges: { display: 'flex', gap: 6, alignItems: 'center' },
      badgeStale: {
        fontFamily: mono,
        fontSize: 10.5,
        padding: '2px 7px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-l2)',
        color: 'var(--dsw-alias-label-secondary)',
      },
      tabs: {
        display: 'flex',
        gap: 2,
        borderBottom: '1px solid var(--dsw-alias-border-l2)',
      },
      tab: (on) => ({
        padding: '0 2px 7px',
        marginRight: 16,
        font: 'inherit',
        fontSize: 13,
        cursor: 'pointer',
        background: 'transparent',
        border: 'none',
        borderBottom: '2px solid ' + (on ? 'var(--dsw-alias-state-business-primary)' : 'transparent'),
        color: on ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
        fontWeight: on ? 600 : 400,
      }),
      chips: { display: 'flex', gap: 6, flexWrap: 'wrap' },
      chip: (on) => ({
        height: 24,
        padding: '0 10px',
        borderRadius: 999,
        border: '1px solid ' + (on ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-border-l2)'),
        background: on ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
        color: on ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
        fontFamily: 'inherit',
        fontSize: 12,
        cursor: 'pointer',
      }),
      table: { width: '100%', borderCollapse: 'collapse', fontVariantNumeric: 'tabular-nums' },
      th: {
        position: 'sticky',
        top: 0,
        zIndex: 1,
        textAlign: 'left',
        fontWeight: 500,
        fontSize: 10.5,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: 'var(--dsw-alias-label-secondary)',
        background: 'var(--dsw-alias-bg-layer-1)',
        borderBottom: '1px solid var(--dsw-alias-border-l2)',
        padding: '7px 8px',
        whiteSpace: 'nowrap',
      },
      td: { padding: '7px 8px', borderBottom: '1px solid var(--dsw-alias-border-l2)', whiteSpace: 'nowrap' },
      num: { textAlign: 'right', fontFamily: mono, fontSize: 12 },
      rank: { fontFamily: mono, fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)', width: 46 },
      colType: { width: 92 },
      colNum: { width: 76, textAlign: 'right' },
      colCov: { width: 132 },
      colYear: { width: 116, textAlign: 'right' },
      cov: { display: 'flex', alignItems: 'center', gap: 8 },
      covTrack: {
        position: 'relative',
        width: 64,
        height: 6,
        borderRadius: 2,
        background: 'var(--dsw-alias-border-l2)',
        overflow: 'hidden',
      },
      covFill: { position: 'absolute', top: 0, bottom: 0, left: 0, background: 'var(--dsw-alias-state-business-primary)' },
      covPct: {
        fontFamily: mono,
        fontSize: 10.5,
        color: 'var(--dsw-alias-label-secondary)',
        width: 30,
        textAlign: 'right',
      },
      name: { fontWeight: 600 },
      fam: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11.5 },
      tag: {
        fontFamily: mono,
        fontSize: 10,
        letterSpacing: '0.06em',
        padding: '2px 5px',
        borderRadius: 3,
        border: '1px solid var(--dsw-alias-border-l2)',
        color: 'var(--dsw-alias-label-secondary)',
      },
      dot: {
        display: 'inline-block',
        width: 6,
        height: 6,
        borderRadius: 999,
        marginLeft: 6,
        background: 'var(--dsw-alias-state-business-primary)',
        opacity: 0.55,
        verticalAlign: 'middle',
      },
      box: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 'var(--dsw-radius-sm)',
        background: 'var(--dsw-alias-bg-layer-2)',
        padding: '14px 16px',
      },
      muted: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 },
      paperRow: {
        display: 'grid',
        gridTemplateColumns: '1fr 96px 78px',
        gap: 12,
        alignItems: 'baseline',
        padding: '11px 4px',
        borderBottom: '1px solid var(--dsw-alias-border-l2)',
      },
      paperTitle: { fontWeight: 600, marginBottom: 3 },
      paperMeta: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11.5, fontFamily: mono },
      fieldChip: {
        fontFamily: mono,
        fontSize: 10,
        padding: '1px 5px',
        borderRadius: 3,
        border: '1px solid var(--dsw-alias-border-l2)',
        color: 'var(--dsw-alias-label-secondary)',
        marginRight: 4,
      },
      foot: {
        marginTop: 'auto',
        paddingTop: 12,
        borderTop: '1px solid var(--dsw-alias-border-l2)',
        fontFamily: mono,
        fontSize: 10.5,
        color: 'var(--dsw-alias-label-secondary)',
        display: 'flex',
        gap: 16,
        flexWrap: 'wrap',
      },
    };

    // §7 FR-9.6：locale 资源以 locale/*.json 为真源，客户端启动时拉一次覆盖；下面这层是断网兜底
    const FALLBACK_ZH = {
      'tab.rank': '算法排行',
      'tab.papers': '论文',
      'tab.trends': '趋势',
      'tab.fields': '领域',
      'tab.cooc': '共现',
      'tab.dict': '词典',
      'app.refresh': '刷新',
      'samples.peek': '先看示例',
      'samples.promote': '转为正式',
      'samples.clear': '清除示例',
      'undo.action': '撤销',
      'undo.dismiss': '知道了',
    };

    const LocaleContext = React.createContext({ t: (key, fallback) => FALLBACK_ZH[key] ?? fallback ?? key });

    function useT() {
      return React.useContext(LocaleContext).t;
    }

    function LocaleProvider({ children }) {
      const [map, setMap] = React.useState(FALLBACK_ZH);
      React.useEffect(() => {
        let alive = true;
        requestJson(BASE + '/locale?lang=zh', { cache: 'no-store' })
          .then((body) => {
            if (alive && body && typeof body === 'object') setMap({ ...FALLBACK_ZH, ...body });
          })
          .catch(() => {});
        return () => {
          alive = false;
        };
      }, []);
      const value = React.useMemo(
        () => ({ t: (key, fallback) => map[key] ?? fallback ?? key }),
        [map]
      );
      return h(LocaleContext.Provider, { value }, children);
    }

    const TYPE_TEXT = { DL: '深度学习', ML: '机器学习', MATH: '数学与优化' };
    const FILTERS = [
      { id: '', label: '全部' },
      { id: 'DL', label: '深度学习' },
      { id: 'ML', label: '机器学习' },
      { id: 'MATH', label: '数学与优化' },
    ];

    function useRadarState(includeSamples) {
      const [state, setState] = useState({ kind: 'loading' });
      const [nonce, setNonce] = useState(0);

      useEffect(() => {
        let alive = true;
        setState({ kind: 'loading' });
        requestJson(BASE + '/state' + (includeSamples ? '?samples=1' : ''), { cache: 'no-store' })
          .then((value) => {
            if (alive) setState({ kind: 'ready', value });
          })
          .catch((error) => {
            if (alive) setState({ kind: 'error', message: error && error.message ? error.message : String(error) });
          });
        return () => {
          alive = false;
        };
      }, [nonce, includeSamples]);

      const reload = useCallback(() => setNonce((n) => n + 1), []);
      return [state, reload];
    }

    function Stats({ value }) {
      return h(
        'div',
        { style: S.stats },
        h('span', { style: S.statNum }, String(value.paperCount)),
        h('span', null, '篇论文'),
        h('span', null, '·'),
        h('span', { style: S.statNum }, String(value.algorithmCount)),
        h('span', null, '个算法'),
        h('span', null, '·'),
        h('span', { style: S.statNum }, String(value.mentionCount)),
        h('span', null, '次提及'),
        value.abstractOnlyCount > 0 ? h('span', null, '·' + value.abstractOnlyCount + ' 篇仅摘要') : null
      );
    }

    /** 窄屏判定（FR-4.3：720px 以下降级）。 */
    function useNarrow() {
      const [narrow, setNarrow] = React.useState(typeof window === 'undefined' ? false : window.innerWidth < 720);
      React.useEffect(() => {
        const onResize = () => setNarrow(window.innerWidth < 720);
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
      }, []);
      return narrow;
    }

    /** 图表的表格视图（FR-9.4 可访问性：每张图表都必须配表格）。 */
    function ChartTable({ columns, rows, caption }) {
      return h(
        'div',
        { style: { overflowX: 'auto' } },
        h(
          'table',
          { style: { ...S.table, minWidth: 'auto' }, 'data-radar-chart-table': '1' },
          caption ? h('caption', { style: { ...S.muted, textAlign: 'left', paddingBottom: 6 } }, caption) : null,
          h('thead', null, h('tr', null, ...columns.map((c) => h('th', { key: c, style: S.th }, c)))),
          h(
            'tbody',
            null,
            ...rows.map((row, index) =>
              h('tr', { key: index }, ...row.map((cell, cellIndex) => h('td', { key: cellIndex, style: S.td }, String(cell))))
            )
          )
        )
      );
    }

    /** 空库三入口（S-j）：搜领域 / 粘正文 / 载入示例。 */
    function Empty({ onRefresh, onLoadSamples, loadingSamples }) {
      const rows = [
        { title: '① 粘一篇正文', body: '把论文正文（摘要 + 方法 + 实验，≥300 字）发给我，说「加进雷达」，或直接调用 radar_add。' },
        { title: '② 搜一个领域', body: '说「搜一下 空气质量预测」，用 radar_discover 拿候选，再挑几篇登记。' },
        { title: '③ 先看示例', body: '载入 6 篇示例数据试玩。示例默认不计入统计，可一键清除或转为正式。' },
      ];
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h(
          'div',
          { style: S.box },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '算法库还是空的'),
          ...rows.map((row) =>
            h(
              'div',
              { key: row.title, style: { padding: '6px 0', borderTop: '1px solid var(--dsw-alias-border-l2)' } },
              h('div', { style: { fontWeight: 600, fontSize: 12.5, marginBottom: 2 } }, row.title),
              h('div', { style: S.muted }, row.body)
            )
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 8, marginTop: 10 } },
            h('button', { style: S.btn, onClick: onLoadSamples, disabled: loadingSamples }, loadingSamples ? '载入中…' : '载入示例数据'),
            h('button', { style: S.btn, onClick: onRefresh }, '重新读取')
          )
        )
      );
    }

    /** 示例横幅：明确标记「不计入统计」，并给 计入开关 / 清除 / 转正。 */
    function SampleBanner({ count, onClear, onPromote, busy, included, onToggle }) {
      if (!count) return null;
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '8px 12px',
            border: '1px dashed var(--dsw-alias-border-l2)',
            borderRadius: 'var(--dsw-radius-sm)',
          },
          'data-radar-samples': String(count),
        },
        h('span', { style: { fontSize: 12.5 } }, `示例数据 ${count} 篇`),
        h('span', { style: S.muted }, included ? '当前计入统计（临时）' : '不计入排行 / 统计 / 趋势 / 覆盖率'),
        h('span', { style: { flex: 1 } }),
        h('button', { style: S.btn, onClick: onToggle, disabled: busy }, included ? '恢复默认（不计入）' : '先看示例'),
        h('button', { style: S.btn, onClick: onPromote, disabled: busy }, '转为正式'),
        h('button', { style: S.btn, onClick: onClear, disabled: busy }, '清除示例')
      );
    }

    function Failed({ message, onRetry }) {
      return h(
        'div',
        { style: S.box },
        h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '读不到算法库'),
        h('div', { style: S.muted }, 'GET ' + BASE + '/state 失败：' + message),
        h('button', { style: Object.assign({}, S.btn, { marginTop: 10 }), onClick: onRetry }, '重试')
      );
    }

    function RankTable({ value, filter, setFilter, onSelect, fieldFilter, setFieldFilter, keyword, setKeyword }) {
      const narrow = useNarrow();
      const rows = useMemo(() => {
        let list = filter === '' ? value.algorithms : value.algorithms.filter((a) => a.type === filter);
        const needle = keyword.trim().toLowerCase();
        if (needle !== '') {
          list = list.filter(
            (a) => a.name.toLowerCase().includes(needle) || String(a.family ?? '').toLowerCase().includes(needle)
          );
        }
        return list;
      }, [value.algorithms, filter, keyword]);

      // FR-3.4：覆盖率分母 = **当前筛选条件下的论文数**，条旁显式给百分比与分母。
      // 注意：value.papers 最多 60 条，超大库下这里会偏小——面板上会标注。
      const filteredPapers = useMemo(() => {
        let list = value.papers ?? [];
        if (filter !== '') list = list.filter((p) => (p.types ?? []).includes(filter));
        if (fieldFilter !== '') list = list.filter((p) => (p.fields ?? []).includes(fieldFilter));
        return list;
      }, [value.papers, filter, fieldFilter]);
      const denominator = filter === '' && fieldFilter === '' ? value.paperCount : filteredPapers.length;
      const denominatorCapped = filter !== '' || fieldFilter !== '' ? (value.papers?.length ?? 0) < value.paperCount : false;

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h(
          'div',
          { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
          h('input', {
            type: 'search',
            value: keyword,
            placeholder: '过滤算法名 / 分类…',
            onChange: (event) => setKeyword(event.target.value),
            style: {
              height: 26,
              width: 220,
              padding: '0 8px',
              borderRadius: 'var(--dsw-radius-sm)',
              border: '1px solid var(--dsw-alias-border-l2)',
              background: 'transparent',
              color: 'var(--dsw-alias-label-primary)',
              font: 'inherit',
              fontSize: 12,
            },
          }),
          FILTERS.map((f) =>
            h(
              'button',
              { key: f.id || 'all', style: S.chip(filter === f.id), onClick: () => setFilter(f.id) },
              f.label
            )
          ),
          (value.fields ?? []).length > 0
            ? h('span', { style: { width: 1, height: 16, background: 'var(--dsw-alias-border-l2)' } })
            : null,
          (value.fields ?? []).slice(0, 4).map((f) =>
            h(
              'button',
              {
                key: f.field,
                style: S.chip(fieldFilter === f.field),
                onClick: () => setFieldFilter(fieldFilter === f.field ? '' : f.field),
              },
              `${f.field} ${f.count}`
            )
          ),
          h(
            'span',
            { style: { ...S.muted, marginLeft: 'auto' } },
            `覆盖率分母：${denominator} 篇${denominatorCapped ? '（按已加载论文计）' : ''}`
          )
        ),
        h(
          'table',
          { style: S.table },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              h('th', { style: Object.assign({}, S.th, S.rank) }, '#'),
              h('th', { style: S.th }, '算法'),
              h('th', { style: Object.assign({}, S.th, S.colType) }, '类型'),
              h('th', { style: Object.assign({}, S.th, S.colNum) }, '论文'),
              h('th', { style: Object.assign({}, S.th, S.colNum) }, '提及'),
              h('th', { style: Object.assign({}, S.th, S.colCov) }, '覆盖'),
              narrow ? null : h('th', { style: Object.assign({}, S.th, S.colYear) }, '年份')
            )
          ),
          h(
            'tbody',
            null,
            rows.map((row, index) => {
              const pct = denominator > 0 ? row.papers / denominator : 0;
              return h(
                'tr',
                { key: row.id, onClick: () => onSelect(row.id), style: { cursor: 'pointer' }, title: '点开看论文清单与证据片段' },
                h('td', { style: Object.assign({}, S.td, S.rank) }, index + 1),
                h(
                  'td',
                  { style: S.td },
                  h(
                    'div',
                    { style: S.name },
                    row.name,
                    row.stale === true ? h('span', { style: S.dot, title: '有旧口径提及，待重算' }) : null
                  ),
                  row.family ? h('div', { style: S.fam }, row.family) : null
                ),
                h('td', { style: Object.assign({}, S.td, S.colType) }, h('span', { style: S.tag }, row.type)),
                h('td', { style: Object.assign({}, S.td, S.num, S.colNum, { fontWeight: 600 }) }, row.papers),
                h('td', { style: Object.assign({}, S.td, S.num, S.colNum) }, row.mentions),
                h(
                  'td',
                  { style: Object.assign({}, S.td, S.colCov) },
                  h(
                    'div',
                    { style: S.cov },
                    h(
                      'div',
                      { style: S.covTrack },
                      h('div', { style: Object.assign({}, S.covFill, { width: Math.round(pct * 100) + '%' }) })
                    ),
                    h('span', { style: S.covPct }, Math.round(pct * 100) + '%'),
                    h('span', { style: { ...S.muted, fontSize: 10 } }, `${row.papers}/${denominator}`)
                  )
                ),
                narrow
                  ? null
                  : h(
                      'td',
                      { style: Object.assign({}, S.td, S.num, S.colYear, { color: 'var(--dsw-alias-label-secondary)' }) },
                      row.firstYear === null
                        ? '—'
                        : row.firstYear === row.lastYear
                          ? String(row.firstYear)
                          : row.firstYear + '–' + row.lastYear
                    )
              );
            })
          )
        ),
        rows.length === 0 ? h('div', { style: S.muted }, '这一类下面还没有登记过的算法。') : null
      );
    }

    function PaperList({ value, onDelete }) {
      if (value.papers.length === 0) {
        return h('div', { style: S.muted }, '还没有登记过论文。');
      }
      return h(
        'div',
        null,
        h('div', { style: S.muted, marginBottom: 6 }, `共 ${value.paperCount} 篇，按登记时间倒序（显示最近 ${value.papers.length} 篇）`),
        value.papers.map((paper) =>
          h(
            'div',
            { key: paper.id, style: S.paperRow },
            h(
              'div',
              null,
              h('div', { style: S.paperTitle }, paper.title),
              h(
                'div',
                { style: S.paperMeta },
                (paper.year === null ? '—' : paper.year) + ' · ' + (paper.venue || '未注会议'),
                paper.depth === 'abstract' ? ' · 仅摘要' : ' · 全文',
                paper.hasText === true ? '' : ' · 无正文'
              ),
              paper.fields && paper.fields.length > 0
                ? h(
                    'div',
                    { style: { marginTop: 4 } },
                    paper.fields.map((field) => h('span', { key: field, style: S.fieldChip }, field))
                  )
                : null
            ),
            h('div', { style: Object.assign({}, S.num, { textAlign: 'left' }) }, `${paper.hitCount} 个算法`),
            h(
              'div',
              { style: { textAlign: 'right', fontFamily: mono, fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
              h(
                'div',
                null,
                (paper.top || []).slice(0, 2).map((item) => `${item.name}×${item.count}`).join(' · ') || '—'
              ),
              onDelete
                ? h(
                    'button',
                    {
                      style: Object.assign({}, S.btn, { marginTop: 6, height: 22, fontSize: 11 }),
                      onClick: (event) => {
                        event.stopPropagation();
                        onDelete(paper);
                      },
                      title: '删除这篇（10 秒内可撤销）',
                    },
                    '删除'
                  )
                : null
            )
          )
        )
      );
    }

    /** 算法详情：点排行行进入（FR-3.5）。数据来自 GET /algorithm?id=。 */
    function AlgorithmDetail({ id, onBack }) {
      const [state, setState] = React.useState({ kind: 'loading' });
      const [nonce, setNonce] = React.useState(0);

      React.useEffect(() => {
        let alive = true;
        setState({ kind: 'loading' });
        requestJson(BASE + '/algorithm?id=' + encodeURIComponent(id), { cache: 'no-store' })
          .then((value) => {
            if (alive) setState({ kind: 'ready', value });
          })
          .catch((error) => {
            if (alive) setState({ kind: 'error', message: error?.message ?? String(error) });
          });
        return () => {
          alive = false;
        };
      }, [id, nonce]);

      const back = h('button', { style: S.btn, onClick: onBack }, '← 返回排行');

      if (state.kind === 'loading') {
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } }, back, h('div', { style: S.muted }, '正在读详情…'));
      }
      if (state.kind === 'error') {
        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
          back,
          h(Failed, { message: state.message, onRetry: () => setNonce((n) => n + 1) })
        );
      }

      const value = state.value;
      const algo = value.algorithm;
      const sectionRows = Object.entries(value.sections ?? {})
        .filter(([, count]) => count > 0)
        .sort((a, b) => b[1] - a[1]);
      const maxSection = sectionRows.length > 0 ? sectionRows[0][1] : 1;
      const maxYear = (value.years ?? []).reduce((m, y) => Math.max(m, y.papers), 1);

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 14 }, 'data-radar-detail': id },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' } },
          back,
          h('span', { style: { fontSize: 18, fontWeight: 600 } }, algo.name),
          h('span', { style: S.tag }, algo.type),
          algo.family ? h('span', { style: S.fam }, algo.family) : null,
          h('span', { style: { marginLeft: 'auto', ...S.muted } },
            `${value.papersCount} 篇论文 · ${value.mentionCount} 次提及 · ${value.firstYear ?? '—'}–${value.lastYear ?? '—'}`)
        ),
        sectionRows.length > 0
          ? h(
              'div',
              null,
              h('div', { style: { ...S.muted, marginBottom: 6 } }, '章节分布'),
              ...sectionRows.map(([key, count]) =>
                h(
                  'div',
                  { key, style: { display: 'grid', gridTemplateColumns: '64px 1fr 40px', gap: 10, alignItems: 'center', padding: '2px 0' } },
                  h('span', { style: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' } }, key),
                  h(
                    'div',
                    { style: { height: 8, background: 'var(--dsw-alias-border-l2)', borderRadius: 2, position: 'relative', overflow: 'hidden' } },
                    h('div', { style: { position: 'absolute', inset: 0, width: Math.round((count / maxSection) * 100) + '%', background: 'var(--dsw-alias-state-business-primary)' } })
                  ),
                  h('span', { style: { fontFamily: mono, fontSize: 11, textAlign: 'right', color: 'var(--dsw-alias-label-secondary)' } }, count)
                )
              )
            )
          : null,
        (value.years ?? []).length > 0
          ? h(
              'div',
              null,
              h('div', { style: { ...S.muted, marginBottom: 6 } }, '年份分布'),
              h(
                'div',
                { style: { display: 'flex', alignItems: 'flex-end', gap: 6, height: 48 } },
                ...(value.years ?? []).map((y) =>
                  h(
                    'div',
                    { key: y.year, title: `${y.year}：${y.papers} 篇`, style: { width: 30, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 } },
                    h('div', { style: { width: 18, height: Math.max(3, Math.round((y.papers / maxYear) * 38)), background: 'var(--dsw-alias-state-business-primary)', opacity: 0.7, borderRadius: 2 } }),
                    h('span', { style: { fontFamily: mono, fontSize: 9, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' } }, String(y.year))
                  )
                )
              )
            )
          : null,
        h(
          'div',
          null,
          h('div', { style: { ...S.muted, marginBottom: 6 } }, `命中论文（${value.total}）`),
          ...(value.papers ?? []).map((paper) =>
            h(
              'div',
              { key: paper.id, style: { padding: '9px 0', borderBottom: '1px solid var(--dsw-alias-border-l2)' } },
              h(
                'div',
                { style: { display: 'flex', gap: 10, alignItems: 'baseline' } },
                h('span', { style: { fontWeight: 600 } }, paper.title),
                paper.stale ? h('span', { style: S.dot, title: '旧口径' }) : null,
                h('span', { style: { marginLeft: 'auto', fontFamily: mono, fontSize: 11.5 } }, `×${paper.count}`)
              ),
              h('div', { style: S.paperMeta }, (paper.year ?? '—') + ' · ' + (paper.venue || '未注会议')),
              ...paper.snippets.slice(0, 2).map((snip, index) =>
                h(
                  'div',
                  {
                    key: index,
                    style: {
                      marginTop: 6,
                      paddingLeft: 10,
                      borderLeft: '2px solid var(--dsw-alias-border-l2)',
                      fontSize: 11.5,
                      lineHeight: 1.6,
                      color: 'var(--dsw-alias-label-secondary)',
                    },
                  },
                  snip
                )
              )
            )
          )
        )
      );
    }

    /** 趋势（FR-4.x）：按年份画若干算法的论文数。 */
    function TrendView({ includeSamples }) {
      const [state, setState] = React.useState({ kind: 'loading' });
      const [asTable, setAsTable] = React.useState(false);
      const [axis, setAxis] = React.useState('year');
      const narrow = useNarrow();
      React.useEffect(() => {
        let alive = true;
        requestJson(BASE + '/trends?limit=5&axis=' + axis + (includeSamples ? '&samples=1' : ''), { cache: 'no-store' })
          .then((value) => alive && setState({ kind: 'ready', value }))
          .catch((error) => alive && setState({ kind: 'error', message: error?.message ?? String(error) }));
        return () => {
          alive = false;
        };
      }, [includeSamples, axis]);

      if (state.kind === 'loading') return h('div', { style: S.muted }, '正在读趋势…');
      if (state.kind === 'error') return h('div', { style: S.muted }, '读趋势失败：' + state.message);

      const value = state.value;
      const years = value.years ?? [];
      if (value.series.length === 0 || years.length === 0) {
        return h('div', { style: S.muted }, '还没有带年份的论文，趋势画不出来。登记时补上 year 就会出现在这里。');
      }

      // 稀疏数据（每年 0–2 篇）画折线会全部重叠在同一高度，所以用「行=算法、列=年份」的网格。
      const yearIndex = new Map(years.map((y, i) => [y, i]));
      const maxPapers = Math.max(1, ...value.series.flatMap((s) => s.points.map((p) => p.papers)));

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 10 }, 'data-radar-trend': '1' },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', { style: { ...S.muted, fontSize: 11.5 } }, '行=算法 · 列=年份 · 数字=当年论文数'),
          h('button', { style: S.chip(axis === 'year'), onClick: () => setAxis('year') }, '发表年'),
          h('button', { style: S.chip(axis === 'readAt'), onClick: () => setAxis('readAt') }, '入库年'),
          h('span', { style: { flex: 1 } }),
          h('button', { style: { ...S.btn, height: 22, fontSize: 11 }, onClick: () => setAsTable((v) => !v) }, asTable ? '看网格' : '看表格')
        ),
        asTable
          ? h(ChartTable, {
              caption: `趋势（${value.yearMin}–${value.yearMax}）`,
              columns: ['算法', ...years.map(String)],
              rows: value.series.map((s) => [s.name, ...years.map((y) => s.points.find((p) => p.year === y)?.papers ?? 0)]),
            })
          : null,
        asTable
          ? null
          : h(
          'div',
          { style: { display: 'grid', gridTemplateColumns: `120px repeat(${years.length}, ${narrow ? 56 : 84}px)`, gap: 2, alignItems: 'center', justifyContent: 'start', overflowX: 'auto' } },
          h('span', { style: { ...S.muted, fontSize: 10 } }, '算法 \\ 年份'),
          ...years.map((year) => h('span', { key: 'h' + year, style: { ...S.muted, fontSize: 10, textAlign: 'center' } }, String(year))),
          ...value.series.flatMap((series) => [
            h('span', { key: series.id, style: { fontSize: 12, paddingRight: 6, whiteSpace: 'nowrap' } }, series.name),
            ...years.map((year) => {
              const point = series.points.find((p) => p.year === year);
              const count = point ? point.papers : 0;
              return h(
                'div',
                {
                  key: series.id + year,
                  title: `${series.name} · ${year}：${count} 篇`,
                  style: {
                    height: 22,
                    borderRadius: 2,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontFamily: mono,
                    fontSize: 10.5,
                    background: count === 0 ? 'var(--dsw-alias-bg-layer-2)' : 'var(--dsw-alias-state-business-primary)',
                    opacity: count === 0 ? 0.5 : 0.35 + 0.65 * (count / maxPapers),
                    color: 'var(--dsw-alias-label-primary)',
                  },
                },
                count === 0 ? '' : String(count)
              );
            }),
          ])
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' } },
          h('span', null, `共 ${value.series.length} 个算法 · ${years.length} 个年份（${value.yearMin}–${value.yearMax}）`),
          value.undatedCount > 0 ? h('span', null, `另有 ${value.undatedCount} 篇无年份未计入`) : null
        )
      );
    }

    /** 领域分布（FR-5.4）：横向条，不用环图。 */
    function FieldsView({ includeSamples }) {
      const [state, setState] = React.useState({ kind: 'loading' });
      const [asTable, setAsTable] = React.useState(false);
      React.useEffect(() => {
        let alive = true;
        requestJson(BASE + '/fields' + (includeSamples ? '?samples=1' : ''), { cache: 'no-store' })
          .then((value) => alive && setState({ kind: 'ready', value }))
          .catch((error) => alive && setState({ kind: 'error', message: error?.message ?? String(error) }));
        return () => {
          alive = false;
        };
      }, [includeSamples]);

      if (state.kind === 'loading') return h('div', { style: S.muted }, '正在读领域分布…');
      if (state.kind === 'error') return h('div', { style: S.muted }, '读领域失败：' + state.message);

      const value = state.value;
      if (value.fields.length === 0) return h('div', { style: S.muted }, '还没有领域标签。登记时传 fields 就会出现在这里。');
      const max = Math.max(1, ...value.fields.map((f) => f.count));

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 10 }, 'data-radar-fields': '1' },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', { style: S.muted }, `共 ${value.total} 篇，分布在 ${value.fields.length} 个领域`),
          h('span', { style: { flex: 1 } }),
          h(
            'button',
            { style: { ...S.btn, height: 22, fontSize: 11 }, onClick: () => setAsTable((v) => !v) },
            asTable ? '看条形' : '看表格'
          )
        ),
        asTable
          ? h(ChartTable, {
              caption: '领域分布',
              columns: ['领域', '论文数'],
              rows: [...value.fields.map((f) => [f.name, f.count]), ...(value.unclassified > 0 ? [['未分类', value.unclassified]] : [])],
            })
          : null,
        ...(asTable ? [] : value.fields).map((f) =>
          h(
            'div',
            { key: f.name, style: { display: 'grid', gridTemplateColumns: '160px 1fr 52px', gap: 12, alignItems: 'center' } },
            h('span', { style: { fontSize: 12.5 } }, f.name),
            h(
              'div',
              { style: { height: 10, background: 'var(--dsw-alias-border-l2)', borderRadius: 2, overflow: 'hidden' } },
              h('div', {
                style: {
                  width: Math.round((f.count / max) * 100) + '%',
                  height: '100%',
                  background: 'var(--dsw-alias-state-business-primary)',
                  opacity: 0.75,
                },
              })
            ),
            h('span', { style: { fontFamily: mono, fontSize: 11.5, textAlign: 'right' } }, f.count)
          )
        ),
        value.unclassified > 0 && !asTable ? h('div', { style: S.muted }, `未分类：${value.unclassified} 篇`) : null
      );
    }

    /** 共现（FR-3.6）：哪两个算法常同篇出现。 */
    function CooccurrenceView({ includeSamples }) {
      const [state, setState] = React.useState({ kind: 'loading' });
      const [minPapers, setMinPapers] = React.useState(1);
      React.useEffect(() => {
        let alive = true;
        setState({ kind: 'loading' });
        requestJson(BASE + '/cooccurrence?limit=30&minPapers=' + minPapers + (includeSamples ? '&samples=1' : ''), {
          cache: 'no-store',
        })
          .then((value) => alive && setState({ kind: 'ready', value }))
          .catch((error) => alive && setState({ kind: 'error', message: error?.message ?? String(error) }));
        return () => {
          alive = false;
        };
      }, [includeSamples, minPapers]);

      if (state.kind === 'loading') return h('div', { style: S.muted }, '正在算共现…');
      if (state.kind === 'error') return h('div', { style: S.muted }, '算共现失败：' + state.message);

      const value = state.value;
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 10 }, 'data-radar-cooc': '1' },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('span', { style: S.muted }, `共 ${value.paperCount} 篇，命中 ${value.totalPairs} 对组合`),
          h('span', { style: { flex: 1 } }),
          h('span', { style: { ...S.muted, fontSize: 11.5 } }, '门槛'),
          ...[1, 2, 3].map((n) =>
            h('button', { key: n, style: S.chip(minPapers === n), onClick: () => setMinPapers(n) }, `≥${n} 篇`)
          )
        ),
        value.pairs.length === 0
          ? h(
              'div',
              { style: S.muted },
              minPapers > 1
                ? `没有共同出现在 ≥${minPapers} 篇论文里的组合。把门槛降到 1 篇，或再多登记几篇论文。`
                : '还没有同篇出现的算法对：登记几篇正文后再来看。'
            )
          : h(ChartTable, {
              caption: 'lift > 1 表示比随机更常一起出现',
              columns: ['算法 A', '算法 B', '共同篇数', 'A 的篇数', 'B 的篇数', 'lift'],
              rows: value.pairs.map((p) => [p.a.name, p.b.name, p.papers, p.papersA, p.papersB, p.lift]),
            })
      );
    }

    /**
     * FR-2.10：词典页的类型筛选（纯函数，便于单测）。
     * 只影响表格，不影响「新增条目」的类型选择。
     */
    function filterDictEntries(entries, type) {
      const list = Array.isArray(entries) ? entries : [];
      return type === 'ALL' ? list : list.filter((entry) => entry.type === type);
    }

    /** 各类型条数（筛选按钮上的计数）。 */
    function countDictTypes(entries) {
      const counts = { DL: 0, ML: 0, MATH: 0 };
      for (const entry of Array.isArray(entries) ? entries : []) {
        if (counts[entry.type] !== undefined) counts[entry.type] += 1;
      }
      return counts;
    }

    /** 词典管理（FR-2.7）：列表 + 新增 + 删除；改完会提示旧提及变旧口径。 */
    function DictionaryView({ onChanged }) {
      const [state, setState] = React.useState({ kind: 'loading' });
      const [nonce, setNonce] = React.useState(0);
      const [name, setName] = React.useState('');
      const [aliases, setAliases] = React.useState('');
      const [type, setType] = React.useState('MATH');
      // FR-2.10：列表筛选与「新条目类型」是两件事，各用一份状态，互不串味。
      const [filterType, setFilterType] = React.useState('ALL');
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const [candidates, setCandidates] = React.useState([]);

      React.useEffect(() => {
        let alive = true;
        requestJson(BASE + '/dictionary', { cache: 'no-store' })
          .then((value) => alive && setState({ kind: 'ready', value }))
          .catch((err) => alive && setState({ kind: 'error', message: err?.message ?? String(err) }));
        return () => {
          alive = false;
        };
      }, [nonce]);

      const loadCandidates = React.useCallback(async () => {
        try {
          const body = await requestJson(BASE + '/candidates', { cache: 'no-store' });
          setCandidates((body.items ?? []).filter((item) => item.status === 'pending'));
        } catch {
          /* 候选读不到不影响词典页 */
        }
      }, []);

      React.useEffect(() => {
        loadCandidates();
      }, [loadCandidates, nonce]);

      const decide = async (id, action) => {
        setError('');
        setBusy(true);
        try {
          const body = await requestJson(BASE + '/candidates', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action, id }),
          });
          await loadCandidates();
          if (action === 'approve' && body.dictionary) setState({ kind: 'ready', value: body.dictionary });
          else setNonce((n) => n + 1);
          if (typeof onChanged === 'function') onChanged();
        } catch (err) {
          setError(err?.message ?? String(err));
        } finally {
          setBusy(false);
        }
      };

      const mutate = async (payload) => {
        setError('');
        setBusy(true);
        try {
          const body = await requestJson(BASE + '/dictionary', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          });
          setState({ kind: 'ready', value: body.dictionary });
          if (typeof onChanged === 'function') onChanged();
        } catch (err) {
          setError(err?.message ?? String(err));
        } finally {
          setBusy(false);
        }
      };

      if (state.kind === 'loading') return h('div', { style: S.muted }, '正在读词典…');
      if (state.kind === 'error') return h('div', { style: S.muted }, '读词典失败：' + state.message);

      const value = state.value;
      // FR-2.10：类型筛选只影响表格，不影响「新增条目」的类型选择。
      const allEntries = Array.isArray(value.entries) ? value.entries : [];
      const typeCounts = countDictTypes(allEntries);
      const shownEntries = filterDictEntries(allEntries, filterType);
      const inputStyle = {
        height: 26,
        padding: '0 8px',
        borderRadius: 'var(--dsw-radius-sm)',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: 12,
      };
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 12 }, 'data-radar-dict': '1' },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } },
          h('span', { style: { fontWeight: 600 } }, `词典 ${value.version}`),
          h('span', { style: S.muted }, `${value.count} 条 · 自定义 ${value.customCount} · 禁用 ${value.disabledCount}`),
          h('span', { style: { ...S.muted, marginLeft: 'auto' } }, '改词典后旧提及会变「旧口径」，可再跑 radar_reextract')
        ),
        candidates.length > 0
          ? h(
              'div',
              { style: { ...S.box, padding: '10px 12px' }, 'data-radar-candidates': String(candidates.length) },
              h('div', { style: { fontWeight: 600, fontSize: 12.5, marginBottom: 6 } }, `待采纳候选 ${candidates.length} 条`),
              h(
                'div',
                { style: S.muted },
                '模型在读论文时发现的词典外算法名会进到这里；采纳后会变成正式词条并推高口径版本。'
              ),
              ...candidates.slice(0, 8).map((item) =>
                h(
                  'div',
                  { key: item.id, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderTop: '1px solid var(--dsw-alias-border-l2)' } },
                  h('span', { style: { fontSize: 12.5 } }, item.name),
                  item.seen > 1 ? h('span', { style: S.fam }, `×${item.seen}`) : null,
                  item.note ? h('span', { style: { ...S.fam, marginLeft: 4 } }, item.note.slice(0, 40)) : null,
                  h('span', { style: { flex: 1 } }),
                  h('button', { style: { ...S.btn, height: 22, fontSize: 11 }, disabled: busy, onClick: () => decide(item.id, 'approve') }, '采纳'),
                  h('button', { style: { ...S.btn, height: 22, fontSize: 11 }, disabled: busy, onClick: () => decide(item.id, 'reject') }, '忽略')
                )
              )
            )
          : null,
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('span', { style: { ...S.muted, fontSize: 12, fontWeight: 600 } }, '新增条目'),
          h('input', {
            value: name,
            placeholder: '算法规范名，如 图注意力网络',
            onChange: (e) => setName(e.target.value),
            style: { ...inputStyle, width: 200 },
          }),
          h('input', {
            value: aliases,
            placeholder: '别名，逗号分隔（GAT, graph attention network）',
            onChange: (e) => setAliases(e.target.value),
            style: { ...inputStyle, width: 260 },
          }),
          h('span', { style: { ...S.muted, fontSize: 12 } }, '类型'),
          ...['DL', 'ML', 'MATH'].map((t) =>
            h(
              'button',
              { key: t, style: S.chip(type === t), 'data-radar-dict-newtype': t, onClick: () => setType(t) },
              t
            )
          ),
          h(
            'button',
            {
              style: S.btn,
              disabled: busy || name.trim() === '',
              onClick: async () => {
                await mutate({
                  action: 'add',
                  name: name.trim(),
                  type,
                  aliases: aliases.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
                });
                setName('');
                setAliases('');
              },
            },
            '新增条目'
          )
        ),
        error !== '' ? h('div', { style: { ...S.muted, color: 'var(--dsw-alias-state-business-primary)' } }, error) : null,
        h(
          'div',
          {
            style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
            'data-radar-dict-filter': filterType,
          },
          h('span', { style: { ...S.muted, fontSize: 12, fontWeight: 600 } }, '按类型筛选'),
          ...['ALL', 'DL', 'ML', 'MATH'].map((key) =>
            h(
              'button',
              {
                key,
                style: S.chip(filterType === key),
                'data-radar-dict-filter-chip': key,
                'aria-pressed': filterType === key ? 'true' : 'false',
                onClick: () => setFilterType(key),
              },
              key === 'ALL' ? `全部 ${allEntries.length}` : `${key} ${typeCounts[key]}`
            )
          ),
          filterType === 'ALL'
            ? null
            : h('span', { style: S.muted }, `显示 ${shownEntries.length} / ${allEntries.length} 条`)
        ),
        h(
          'div',
          { style: { overflowX: 'auto' } },
          h(
            'table',
            { style: S.table },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', { style: S.th }, '算法'),
                h('th', { style: S.th }, 'id'),
                h('th', { style: S.th }, '类型'),
                h('th', { style: S.th }, '别名'),
                h('th', { style: S.th }, '论文'),
                h('th', { style: S.th }, '来源'),
                h('th', { style: S.th }, '')
              )
            ),
            h(
              'tbody',
              null,
              ...shownEntries.map((entry) =>
                h(
                  'tr',
                  { key: entry.id, style: entry.status === 'disabled' ? { opacity: 0.45 } : undefined },
                  h('td', { style: S.td }, entry.name),
                  h('td', { style: { ...S.td, ...S.fam } }, entry.id),
                  h('td', { style: S.td }, h('span', { style: S.tag }, entry.type)),
                  h('td', { style: { ...S.td, ...S.fam, maxWidth: 300, whiteSpace: 'normal' } }, entry.aliases.slice(0, 4).join(' / ')),
                  h('td', { style: { ...S.td, ...S.num } }, entry.papers),
                  h('td', { style: { ...S.td, ...S.fam } }, entry.origin === 'custom' ? '自定义' : '内置'),
                  h(
                    'td',
                    { style: S.td },
                    entry.status === 'disabled'
                      ? h('span', { style: S.fam }, '已禁用')
                      : h(
                          'button',
                          {
                            style: { ...S.btn, height: 22, fontSize: 11 },
                            disabled: busy,
                            onClick: () => mutate({ action: 'remove', id: entry.id }),
                          },
                          entry.origin === 'custom' ? '删除' : '禁用'
                        )
                  )
                )
              ),
              shownEntries.length === 0
                ? h('tr', { key: 'empty' }, h('td', { colSpan: 7, style: { ...S.td, ...S.muted } }, '该类型下没有条目'))
                : null
            )
          )
        )
      );
    }

    /** 首次激活引导（FR-11.3）：一次性、可关，存在快照里。 */
    function GuideBar({ onDismiss }) {
      return h(
        'div',
        {
          style: {
            ...S.box,
            padding: '10px 12px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            borderStyle: 'dashed',
          },
          'data-radar-guide': '1',
        },
        h('span', { style: { fontSize: 12.5 } }, '说一句就能登记：把论文正文发给我并说「加进雷达」，或用 radar_discover 搜一个领域。'),
        h('span', { style: { flex: 1 } }),
        h('button', { style: S.btn, onClick: onDismiss }, '知道了')
      );
    }

    /** 设置（FR-12.1 / 12.3）：数据位置 / 体积 / 备份 / 词典 / 能力，全部只读。 */
    function SettingsView({ value }) {
      if (!value) return h('div', { style: S.muted }, '还没有读到状态。');
      const kb = (n) => (typeof n === 'number' ? `${Math.round((n / 1024) * 10) / 10} KB` : '—');
      const rows = [
        ['数据文件', value.storeFile],
        ['库体积', kb(value.dbBytes)],
        ['备份目录', value.backup?.dir ?? '—'],
        ['备份份数', `${value.backup?.count ?? 0} 份（保留 ${value.backup?.keep ?? 7}）`],
        ['最新备份', value.backup?.latest ?? '—'],
        ['词典版本', value.dictVersion],
        ['每篇封顶', value.capPerPaper > 0 ? `${value.capPerPaper} 次` : '不封顶'],
        ['写能力', value.capabilities?.write ? '开启' : '关闭'],
        ['正文读取', value.capabilities?.textRead ? '开启（radar_text 已注册）' : '关闭（radar_text 不注册）'],
        ['工具数', `${(value.tools ?? []).length} 个`],
      ];
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 14 }, 'data-radar-settings': '1' },
        h(
          'div',
          { style: S.box },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '本机数据'),
          ...rows.map(([label, text]) =>
            h(
              'div',
              {
                key: label,
                style: {
                  display: 'grid',
                  gridTemplateColumns: '96px 1fr',
                  gap: 10,
                  padding: '4px 0',
                  borderTop: '1px solid var(--dsw-alias-border-l2)',
                },
              },
              h('span', { style: S.fam }, label),
              h('span', { style: { fontFamily: mono, fontSize: 11.5, wordBreak: 'break-all' } }, String(text))
            )
          )
        ),
        h(
          'div',
          { style: S.box },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '配置项'),
          h(
            'div',
            { style: S.muted },
            '这些开关在 profile 的 cordis.patch.yml 里改，改完重启宿主生效：writeEnabled / capPerPaper / textReadEnabled / undoWindowMs。'
          ),
          h(
            'div',
            { style: { ...S.muted, marginTop: 8 } },
            '不变量：正文永不进入工具返回（除显式开启的 radar_text，单次 ≤8,000 字符）；单次工具返回 ≤12,000 字符；正文只在 texts/ 落盘。'
          )
        )
      );
    }

    /** 撤销条：删除后 10 秒内可点（FR-2.10）。 */
    function UndoBar({ pending, onUndo, onDismiss }) {
      if (pending === null) return null;
      return h(
        'div',
        {
          style: {
            position: 'sticky',
            bottom: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '10px 14px',
            marginTop: 'auto',
            border: '1px solid var(--dsw-alias-border-l2)',
            borderRadius: 'var(--dsw-radius-sm)',
            background: 'var(--dsw-alias-bg-layer-2)',
          },
          'data-radar-undo': pending.token ?? '',
        },
        h('span', { style: { fontSize: 12.5 } }, pending.label),
        h('span', { style: { ...S.muted, marginLeft: 'auto' } }, '10 秒内可撤销'),
        h('button', { style: S.btn, onClick: onUndo }, '撤销'),
        h('button', { style: Object.assign({}, S.btn, { border: 'none' }), onClick: onDismiss }, '知道了')
      );
    }

    function RadarView() {
      const t = useT();
      const [showSamples, setShowSamples] = useState(false);
      const [state, reload] = useRadarState(showSamples);
      const [tab, setTab] = useState('rank');
      const [filter, setFilter] = useState('');
      const [fieldFilter, setFieldFilter] = useState('');
      const [keyword, setKeyword] = useState('');
      const [detailId, setDetailId] = useState('');
      const [pending, setPending] = useState(null);
      const [opError, setOpError] = useState('');
      const [samplesBusy, setSamplesBusy] = useState(false);

      const sampleAction = async (action, extra = {}) => {
        setOpError('');
        setSamplesBusy(true);
        try {
          const body = await requestJson(BASE + '/samples', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action, ...extra }),
          });
          reload();
        } catch (error) {
          setOpError(`示例操作失败：${error?.message ?? error}`);
        } finally {
          setSamplesBusy(false);
        }
      };

      // 撤销条 10 秒后自动消失
      useEffect(() => {
        if (pending === null) return undefined;
        const timer = setTimeout(() => setPending(null), 10000);
        return () => clearTimeout(timer);
      }, [pending]);

      const dismissGuide = async () => {
        try {
          await fetch(BASE + '/guide', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        } catch {
          /* 关不掉也不阻塞 */
        }
        reload();
      };

      const deletePaper = async (paper) => {
        setOpError('');
        try {
          const body = await requestJson(BASE + '/remove', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ paperId: paper.id }),
          });
          setPending({ token: body.undo?.token, label: `已删除《${paper.title}》` });
          reload();
        } catch (error) {
          setOpError(`删除失败：${error?.message ?? error}`);
        }
      };

      const undoDelete = async () => {
        if (pending === null) return;
        try {
          const body = await requestJson(BASE + '/restore', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token: pending.token }),
          });
          setPending(null);
          reload();
        } catch (error) {
          setOpError(`撤销失败：${error?.message ?? error}`);
        }
      };

      let body;
      if (detailId !== '') {
        body = h(AlgorithmDetail, { id: detailId, onBack: () => setDetailId('') });
      } else if (state.kind === 'loading') {
        body = h('div', { style: S.muted }, '正在读算法库…');
      } else if (state.kind === 'error') {
        body = h(Failed, { message: state.message, onRetry: reload });
      } else if (state.value.algorithmCount === 0 && state.value.sampleCount === 0) {
        body = h(Empty, {
          onRefresh: reload,
          onLoadSamples: () => sampleAction('load'),
          loadingSamples: samplesBusy,
        });
      } else if (state.value.algorithmCount === 0) {
        body = h(
          'div',
          { style: S.muted },
          '统计里还没有真实数据（示例不计入）。载入示例后可点「转为正式」把它们计入，或从上面三个入口登记真实论文。'
        );
      } else {
        body = h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
          h(
            'div',
            { style: S.tabs },
            h('button', { style: S.tab(tab === 'rank'), onClick: () => setTab('rank') }, t('tab.rank', '算法排行')),
            h('button', { style: S.tab(tab === 'papers'), onClick: () => setTab('papers') }, t('tab.papers', '论文')),
            h('button', { style: S.tab(tab === 'trends'), onClick: () => setTab('trends') }, t('tab.trends', '趋势')),
            h('button', { style: S.tab(tab === 'fields'), onClick: () => setTab('fields') }, t('tab.fields', '领域')),
            h('button', { style: S.tab(tab === 'cooc'), onClick: () => setTab('cooc') }, t('tab.cooc', '共现')),
            h('button', { style: S.tab(tab === 'dict'), onClick: () => setTab('dict') }, t('tab.dict', '词典')),
            h('button', { style: S.tab(tab === 'settings'), onClick: () => setTab('settings') }, '设置')
          ),
          tab === 'rank'
            ? h(RankTable, {
                value: state.value,
                filter,
                setFilter,
                onSelect: setDetailId,
                fieldFilter,
                setFieldFilter,
                keyword,
                setKeyword,
              })
            : tab === 'papers'
              ? h(PaperList, { value: state.value, onDelete: deletePaper })
              : tab === 'trends'
                ? h(TrendView, { includeSamples: showSamples })
                : tab === 'fields'
                  ? h(FieldsView, { includeSamples: showSamples })
                  : tab === 'cooc'
                    ? h(CooccurrenceView, { includeSamples: showSamples })
                    : tab === 'dict'
                      ? h(DictionaryView, { onChanged: reload })
                      : h(SettingsView, { value: state.value })
        );
      }

      const stalePapers = state.kind === 'ready' ? state.value.stalePapers || 0 : 0;
      const recomputable = state.kind === 'ready' ? state.value.staleRecomputable || 0 : 0;
      // 旧口径但没有留存正文 → 不可重算，得说清楚「需重贴」，别让人以为点一下就好
      const staleBadge =
        stalePapers > 0
          ? recomputable > 0
            ? `待重算 ${stalePapers} 篇`
            : `旧口径 ${stalePapers} 篇 · 无正文`
          : null;

      return h(
        LocaleProvider,
        null,
        h(
        'div',
        { style: S.root, 'data-radar-view': VIEW_ID, 'data-radar-state': state.kind },
        h(
          'div',
          { style: S.top },
          h('h1', { style: S.title }, '论文算法雷达'),
          state.kind === 'ready' ? h(Stats, { value: state.value }) : null,
          stalePapers > 0
            ? h(
                'span',
                {
                  style: S.badgeStale,
                  title:
                    recomputable > 0
                      ? '有旧口径提及，可用 radar_reextract 原地重算'
                      : '这些论文没有留存正文（v0.2 不存正文），重算会跳过，需要重贴或重抓',
                },
                staleBadge
              )
            : null,
          h('span', { style: S.spacer }),
          h('button', { style: S.btn, onClick: reload }, state.kind === 'loading' ? '读取中…' : '刷新')
        ),
        state.kind === 'ready' && state.value.guide?.enabled === true && state.value.guide?.dismissed !== true
          ? h(GuideBar, { onDismiss: dismissGuide })
          : null,
        body,
        h(SampleBanner, {
          count: state.kind === 'ready' ? state.value.sampleCount || 0 : 0,
          onClear: () => sampleAction('clear'),
          onPromote: () => sampleAction('promote', { confirm: true }),
          busy: samplesBusy,
          included: showSamples,
          onToggle: () => setShowSamples((v) => !v),
        }),
        opError !== '' ? h('div', { style: { ...S.muted, color: 'var(--dsw-alias-state-business-primary)' } }, opError) : null,
        h(UndoBar, { pending, onUndo: undoDelete, onDismiss: () => setPending(null) }),
        state.kind === 'ready'
          ? h(
              'div',
              { style: S.foot },
              h('span', null, '数据文件：' + state.value.storeFile),
              h('span', null, '口径：' + state.value.dictVersion),
              h('span', null, '生成于：' + new Date(state.value.generatedAt).toLocaleTimeString())
            )
          : null
        )
      );
    }

    function RadarIcon() {
      return h(
        'svg',
        {
          width: 20,
          height: 20,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinejoin: 'round',
          strokeLinecap: 'round',
        },
        h('circle', { cx: 12, cy: 12, r: 9 }),
        h('circle', { cx: 12, cy: 12, r: 4 }),
        h('path', { d: 'M12 12l6-5' })
      );
    }

    const inject = ['slots'];

    function apply(ctx) {
      if (!ctx || !ctx.slots || typeof ctx.slots.register !== 'function') {
        console.error('[paper-algo-radar] ctx.slots 不可用：client.inject 里缺少 @deepseek-ai/dsh-client-ui-slots');
        return function () {};
      }

      const disposers = [];

      const dMain = ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: VIEW_ID }, RadarView)
      );
      if (typeof dMain === 'function') disposers.push(dMain);

      const dPanel = ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: VIEW_ID, order: PANEL_ORDER, label: () => '论文算法雷达' },
          RadarIcon
        )
      );
      if (typeof dPanel === 'function') disposers.push(dPanel);

      console.info('[paper-algo-radar] panels registered: main + sidebar.panellist');

      return function () {
        for (const fn of disposers) {
          try {
            fn();
          } catch {
            /* 卸载不应抛 */
          }
        }
      };
    }

    // __test 只供本地单测（FR-2.10 的筛选纯函数 + 词典视图组件）；宿主只认 apply / inject。
    module.exports = {
      apply,
      inject,
      __test: { filterDictEntries, countDictTypes, DictionaryView },
    };
    return module.exports;
  },
});
