/**
 * Client half: a sidebar tab that shows what this session's records say.
 *
 * The host half writes two kinds of record into the session log -- one per
 * finished step, one per finished turn -- and they are only reachable by
 * scrolling back through the conversation. This half puts them in a tab.
 *
 * Shape: a closure-factory bundle. `window.__ModuleLoader__.load` with a
 * `factory(require)` is the only form the client module system accepts; React
 * and every host service arrive through the injected `require`, so this file
 * is copied to `lib/` verbatim with no build step and declares no dependency
 * on React.
 *
 * The entries are registered under `sidebarRightTabs` (the service that owns
 * the right panel), and the panel dispatches the component through two seats
 * that must be registered together: `sidebar.right.pane.tab` for the body and
 * `sidebar.right.pane.tab.title` for its title. The seat props are always an
 * empty object -- everything usable arrives in the third argument the host
 * passes to `renderSlot`.
 */

// Which sessions have already had their newest turn record opened, and with
// which id. A tab is remounted before the injected fiber re-fires, and a
// remount resets every ref inside the component -- so this has to live out
// here, where the factory's own call does not rebuild it, or the mounting
// effect cannot tell "the reader just arrived" from "the reader closed the
// panel and it came back".
const openedSessions = new Map()

// Whether the host's right-hand panel is currently open. The panel is a CSS
// transition -- its stylesheet moves it off the right edge and sets
// `visibility: hidden` for as long as `data-sidebar-right-open` is absent -- so
// the attribute the shell sets on the element is the same one the stylesheet
// switches on. The panel element stays in the DOM while collapsed, which is
// what makes this readable at all.
//
// Unreadable means "assume open": a missing element must not turn into a
// plugin that never opens anything. The floating presentation is a portal into
// `document.body`, so it is looked up next to the docked panel.
function sidebarPanelOpen() {
  const panel = document.querySelector('[data-sidebar-right-panel]')
  if (panel !== null) return panel.hasAttribute('data-sidebar-right-open')
  const floats = document.querySelector('[data-sidebar-right-float-host]')
  if (floats !== null) return true
  return true
}

window.__ModuleLoader__.load({
  id: 'dsh-stepwise-distill',
  factory: (require) => {
    const react = require('react')
    const { createElement, useEffect, useState } = react

    const PLUGIN_ID = 'dsh-stepwise-distill'
    /** Identifies this tab among every other right-panel tab. */
    const TAB_ID = 'stepwise-distill'
    /** Distinguishes the tab's kind; the host matches entries by this. */
    const TAB_KIND = 'stepwise-distill'

    // Declared on both sides rather than shared: the host half keeps its own
    // copy in `src/index.js`, and there is no module both halves import.
    const RECORDS_ROUTE = '/api/stepwise-distill/records'

    // The same namespace the host half registers in `src/index.js`. The card
    // claims it by this key, and the Host serves it under the same name, so the
    // two spellings have to stay identical -- declared on both sides for the
    // same reason as the route above.
    const SETTINGS_NAMESPACE = 'stepwise-distill'
    /** The three switches, in the order the card lists them. */
    const SETTINGS_FIELDS = [
      { key: 'stepSummary', label: '步间小结', hint: '每完成一步写一条记录，替换该步的原始材料。' },
      { key: 'turnSummary', label: '轮间小结', hint: '每轮结束补充一条记录。' },
      { key: 'debug', label: '调试日志', hint: '在日志里打印每次诊断。' },
    ]

    /**
     * The card's own stylesheet.
     *
     * A contributed card inherits no styling from the settings section, so it
     * has to bring its own -- measured against the built-in cards, which share
     * this shape: a bordered row, a title over a one-line summary, and a
     * chevron that rotates rather than changing glyph.
     *
     * Only the colour variables are taken from the host; spacing, radii and
     * font sizes are spelled out here, because the aliases carry no layout.
     */
    const CARD_CSS = `
.dshDistillCard {
  border: 0.5px solid var(--dsw-alias-border-l4);
  background: var(--dsw-alias-bg-layer-3);
  border-radius: 16px;
  list-style: none;
  transition: border-color 0.16s, background 0.16s;
}
.dshDistillCard:hover { border-color: var(--dsw-alias-label-dimmed); }
.dshDistillCardOpen {
  background: var(--dsw-alias-bg-layer-2);
  border-color: var(--dsw-alias-label-dimmed);
}
.dshDistillHeader {
  appearance: none;
  width: 100%;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  background: none;
  border: 0;
  border-radius: 12px;
  padding: 14px 16px;
  display: flex;
  align-items: center;
  gap: 12px;
}
.dshDistillHeader:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: -2px;
}
.dshDistillHeadText {
  display: flex;
  flex-direction: column;
  flex: 1;
  gap: 4px;
  min-width: 0;
}
.dshDistillTitle {
  color: var(--dsw-alias-label-primary);
  font-size: 15px;
  font-weight: 600;
  line-height: 1.4;
}
.dshDistillDescription {
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  line-height: 1.5;
}
.dshDistillChevron {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
  transition: transform 0.16s;
}
.dshDistillChevronOpen { transform: rotate(180deg); }
.dshDistillBody {
  border-top: 0.5px solid var(--dsw-alias-border-l2);
  margin: 0 16px;
  padding: 14px 0 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dshDistillRow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.dshDistillLabel {
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.dshDistillHint {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 1.5;
}
`

    /**
     * Put the card's stylesheet in the document once.
     *
     * Idempotent by tag lookup, so a remount does not stack copies, and the
     * disposer removes only the tag this call created.
     */
    function installStyles() {
      const existing = document.querySelector('style[data-plugin-css="dsh-stepwise-distill/card.css"]')
      if (existing !== null) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = PLUGIN_ID
      tag.dataset.pluginCss = `${PLUGIN_ID}/card.css`
      tag.textContent = CARD_CSS
      document.head.appendChild(tag)
      return () => { tag.remove() }
    }

    /**
     * The card under `Settings > Plugins`.
     *
     * It edits the switches the host serves under `SETTINGS_NAMESPACE`, so it
     * owns no state of its own: it renders the scope's snapshot and writes back
     * through it. Claiming the namespace is what puts the card in the list, and
     * the fields it shows are the fields the host schema declares -- a switch
     * for anything else would be rejected on write.
     *
     * Collapsed by default, like the built-in plugin cards: the list is a column
     * of one-line summaries, and an expanded card would push the rest off it.
     */
    function SettingsCard(props) {
      const scope = props?.scope
      const [snapshot, setSnapshot] = useState(() => scope?.getSnapshot?.() ?? {})
      const [open, setOpen] = useState(false)

      useEffect(() => {
        if (typeof scope?.subscribe !== 'function') return undefined
        return scope.subscribe(() => { setSnapshot(scope.getSnapshot()) })
      }, [scope])

      const value = snapshot?.value ?? {}
      const writable = snapshot?.writable === true

      return createElement('li', {
        className: `dshDistillCard${open ? ' dshDistillCardOpen' : ''}`,
      }, [
        createElement('button', {
          key: 'header',
          type: 'button',
          className: 'dshDistillHeader',
          'aria-expanded': open,
          onClick: () => { setOpen(!open) },
        }, [
          createElement('span', { key: 'head', className: 'dshDistillHeadText' }, [
            createElement('span', { key: 'title', className: 'dshDistillTitle' }, '蒸馏'),
            createElement('span', { key: 'summary', className: 'dshDistillDescription' },
              SETTINGS_FIELDS.filter((field) => value[field.key] === true).map((field) => field.label).join('、') || '全部关闭'),
          ]),
          createElement('svg', {
            key: 'chevron',
            className: `dshDistillChevron${open ? ' dshDistillChevronOpen' : ''}`,
            width: 14,
            height: 14,
            viewBox: '0 0 14 14',
            fill: 'none',
            'aria-hidden': true,
          }, createElement('path', {
            d: 'M3.5 5.25 7 8.75l3.5-3.5',
            stroke: 'currentColor',
            strokeWidth: 1.5,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          })),
        ]),
        open && createElement('div', {
          key: 'body',
          className: 'dshDistillBody',
        }, [
          writable ? null : createElement('div', {
            key: 'readonly',
            className: 'dshDistillDescription',
            role: 'status',
          }, '当前设置不可写，以下开关为只读。'),
          ...SETTINGS_FIELDS.map((field) => createElement('div', {
            key: field.key,
            className: 'dshDistillRow',
          }, [
            createElement('div', { key: 'text' }, [
              createElement('label', {
                key: 'label',
                className: 'dshDistillLabel',
                htmlFor: `dsh-distill-${field.key}`,
              }, field.label),
              createElement('p', { key: 'hint', className: 'dshDistillHint' }, field.hint),
            ]),
            createElement('input', {
              key: 'input',
              id: `dsh-distill-${field.key}`,
              type: 'checkbox',
              checked: value[field.key] === true,
              disabled: !writable,
              onChange: () => { void scope.set(field.key, value[field.key] !== true) },
            }),
          ])),
        ]),
      ])
    }

    /**
     * The tab body.
     *
     * The records live in the session log, which only the host half can read:
     * the panel's own paging verb is addressed by `seq`, so it cannot be asked
     * for "everything this session retained". The tab therefore asks the host
     * for the list, and the host answers from the log it already holds.
     */
    function DistillTab(props) {
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : ''
      const [records, setRecords] = useState(null)
      const [error, setError] = useState(null)
      // One open body at a time. The bodies are long enough that several open
      // at once would push every later record off the panel, which defeats the
      // reason for opening one. Keyed by the id the record derives from the
      // span it covers, not by list position: the server answers from the
      // projection, so a later read can drop entries, and an open body must
      // not end up on a different record.
      const [openId, setOpenId] = useState(null)

       // The number of the turn the effects below last opened. Every append
       // moves the log -- step records land the same way -- so `append` alone
       // would re-open a body once per step. The turn number is the one value
       // that changes only when a turn ends, which is what makes the trigger
       // "a turn just finished" rather than "the log moved".
       const lastTurn = react.useRef(null)

       // One reader, not one per effect: the subscribe effect below has to ask
      // for the list again when the log moves, and a `read` defined inside the
      // mounting effect would not be in its closure. It returns the records
      // rather than only setting them, so the caller can compare.
      const read = react.useCallback(async () => {
        if (sessionId === '') return []
        try {
          const response = await fetch(RECORDS_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId }),
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const payload = await response.json()
          if (payload?.ok !== true) throw new Error('records read failed')
          const value = Array.isArray(payload.value) ? payload.value : []
          setRecords(value)
          return value
        } catch (failure) {
          setError(String(failure?.message ?? failure))
          return []
        }
      }, [sessionId])

      useEffect(() => {
        // A tab is remounted before the injected fiber re-fires, so this runs
        // more than once per panel. The abandoned flag is what keeps a slow
        // reply from landing on a newer render's state; `read` itself is shared
        // with the subscribe effect, which has its own cancelled flag.
        if (sessionId === '') { setRecords([]); return undefined }
        // A collapsed panel is not a place to open anything, and the reader who
        // closed it should not have it come back at the end of the next turn.
        // There is nothing to catch up on: the effect runs again when the panel
        // is opened.
        if (!sidebarPanelOpen()) return undefined
        // Open the newest turn record on arrival, so the panel is not a list of
        // collapsed rows the reader has to guess from. The list comes back
        // newest first, so the first turn record is the one to open.
        void read().then((next) => {
          const newest = next.find((item) => item?.kind === 'turn')
          if (newest === undefined) return
          if (typeof newest.turn === 'number') lastTurn.current = newest.turn
          // Opening is a one-time arrival gesture. Once this session has been
          // opened -- whether here or by the subscribe effect -- a later mount
          // only catches up on the list; it does not open anything again, or a
          // panel the reader closed would be forced back open every remount.
          if (openedSessions.has(sessionId)) return
          openedSessions.set(sessionId, newest.id ?? null)
          setOpenId(newest.id ?? null)
        })
        return undefined
      }, [read, sessionId])

      useEffect(() => {
        // A turn record is written while the turn is ending, long after this
        // panel mounted, and the host answers the list request only when asked.
        // The session's event source is what makes that moment visible without
        // polling: it fires as the turn closes, and the read that follows picks
        // up the record. The callback carries nothing, so the change it reports
        // is read back out of the snapshot.
        const sessions = props?.sessions
        if (sessionId === '' || sessions === undefined) return undefined
        const binding = sessions.binding?.(sessionId)
        const source = binding?.eventSource
        if (source === undefined || typeof source.subscribe !== 'function') return undefined

        let cancelled = false
        const unsubscribe = source.subscribe(() => {
          if (cancelled) return
          // Same reason as in the mounting effect: while the panel is closed,
          // rewriting which record is open is a state change the reader never
          // asked for, and it re-renders the whole tab body underneath the
          // panel's own open/close transition.
          if (!sidebarPanelOpen()) return
          const change = source.getSnapshot?.()?.change
          // `settle-assistant` closes an attempt and carries no entries; only an
          // append means the log moved, which is when a record can have landed.
          if (change?.kind !== 'append') return
          // The turn record is written during `agent/turn-stopping`, and the
          // push for that moment carries `turn/end` alone -- the record is not
          // in the batch, so nothing about the entries can name it. Asking
          // again after the log moves is what picks it up, and the newest turn
          // record is the one that just landed.
          void read().then((next) => {
            if (cancelled || next === null) return
            // Sorted by the server, newest first, so the first turn record in
            // the list is the newest one. The turn number is what tells a
            // finished turn apart from a step record landing: within one turn
            // the number does not move, so nothing opens until the turn ends.
            const newest = next.find((item) => item?.kind === 'turn')
            if (newest === undefined) return
            if (typeof newest.turn !== 'number') return
            if (newest.turn <= (lastTurn.current ?? -1)) return
            lastTurn.current = newest.turn
            openedSessions.set(sessionId, newest.id ?? null)
            setOpenId(newest.id ?? null)
          })
        })
        return () => { cancelled = true; unsubscribe?.() }
      }, [props?.sessions, sessionId])

      const loading = records === null && error === null
      const list = records ?? []
      const turns = list.filter((item) => item?.kind === 'turn')
      const steps = list.filter((item) => item?.kind === 'step')
      // The host's compaction checkpoints. Their own group, and last: they
      // cover a span of history rather than a step, so they belong to neither
      // list above, and they are the oldest thing in the panel by nature --
      // everything else was written after the history they replaced.
      const compacts = list.filter((item) => item?.kind === 'compact')

      return createElement('div', {
        className: 'dsh-stepwise-distill',
        style: { padding: '12px', font: '12px/1.6 system-ui, sans-serif' },
      }, [
        createElement('div', {
          key: 'title',
          style: { fontWeight: 600, marginBottom: '6px' },
        }, '蒸馏'),
        error !== null && createElement('div', {
          key: 'error',
          style: { color: '#c0392b' },
        }, `读取失败：${error}`),
        loading && createElement('div', {
          key: 'loading',
          style: { opacity: 0.7 },
        }, '读取中…'),
        !loading && error === null && list.length === 0 && createElement('div', {
          key: 'empty',
          style: { opacity: 0.7 },
        }, '本次会话还没有记录。'),
        section('轮间记录', turns, 'turn', openId, setOpenId),
        section('步间记录', steps, 'step', openId, setOpenId),
        // Renders nothing at all when the session has never been compacted.
        section('压缩内容', compacts, 'compact', openId, setOpenId),
      ])
    }

    /**
     * One group of records, newest first.
     *
     * Grouped rather than listed together because the two kinds answer
     * different questions: a step record replaces the step it covers, a turn
     * record is added on top of everything the turn already had.
     *
     * Bodies start closed -- a session accumulates records faster than anyone
     * reads them, and the labels alone are enough to pick one out. Opening one
     * closes the rest, so the open state is held by the parent rather than by
     * each entry.
     */
    function section(label, items, kind, openId, setOpenId) {
      if (items.length === 0) return null
      // Rendered in the order the route returned, which is newest first. The
      // sort lives there alone: it used to run here too, and the two copies
      // disagreeing is what opened the oldest record instead of the newest.
      return createElement('div', {
        key: `section-${kind}`,
        style: { marginTop: '12px' },
      }, [
        createElement('div', {
          key: 'label',
          style: { fontWeight: 600, opacity: 0.8, marginBottom: '4px' },
      }, `${label}（${items.length}）`),
        ...items.map((item) => {
          // Keyed by the record's own identity, not by list position: a later
          // read can return a different list, and an open body must not land on
          // a different record than it started on.
          const id = item?.id
          const open = openId !== null && id === openId
          return createElement(RecordEntry, {
            key: `entry-${kind}-${id}`,
            label: where(item),
            text: String(item?.text ?? ''),
            open,
            onToggle: () => setOpenId(open ? null : id),
          })
        }),
      ])
    }

    /**
     * One record, as a row that opens in place.
     *
     * A component rather than a function returning elements, because opening a
     * body has to bring it to the top of the panel: the record being read is
     * almost always the newest one, and the panel scrolls, so without this the
     * body opens below the fold and reads as empty.
     *
     * Aligned on the row, not on the body. Bringing the body's own first line
     * to the top pushes the row's title above the fold, so the reader is left
     * looking at an unlabelled block and has to scroll back up to learn what
     * they opened.
     *
     * The scroll rides `open` rather than the click. Collapsing sets it false
     * and must not move the panel.
     */
    function RecordEntry(props) {
      const row = react.useRef(null)
      react.useEffect(() => {
        if (props.open && row.current !== null) row.current.scrollIntoView({ block: 'start' })
      }, [props.open])
      return createElement('div', {
        ref: row,
        style: { borderTop: '1px solid rgba(128,128,128,0.25)', paddingTop: '6px', marginTop: '6px' },
      }, [
        createElement('button', {
          key: 'at',
          type: 'button',
          onClick: props.onToggle,
          style: {
            display: 'block',
            width: '100%',
            textAlign: 'left',
            background: 'none',
            border: 0,
            padding: 0,
            font: 'inherit',
            color: 'inherit',
            opacity: props.open ? 0.95 : 0.6,
            cursor: 'pointer',
          },
        }, `${props.open ? '▾' : '▸'} ${props.label}`),
        props.open && createElement('pre', {
          key: 'text',
          style: { whiteSpace: 'pre-wrap', margin: '4px 0 0', font: 'inherit' },
        }, props.text),
      ])
    }

    /** Where a record belongs, as far as the record itself says. */
    function where(item) {
      if (item?.kind === 'compact') return '压缩'
      if (item?.kind === 'turn') return `turn ${item.turn ?? '?'}`
      if (item?.turn === null || item?.turn === undefined) return '本轮的记录'
      return `turn ${item.turn}, step ${item.step ?? '?'}`
    }

    /** The label shown on the tab strip, and in the panel's guide list. */
    function DistillTabTitle() {
      return createElement('span', null, '蒸馏')
    }

    function apply(ctx) {
      // The card carries its own stylesheet, so this is registered before the
      // card can possibly render.
      ctx.effect(() => installStyles(), `${PLUGIN_ID}: settings card styles`)

      ctx.inject(['sidebarRightTabs'], (injected) => {
        const tabs = injected.sidebarRightTabs
        if (tabs === undefined || typeof tabs.register !== 'function') return

        // Every disposer is collected before anything is registered, so that a
        // failure part-way through unwinds exactly what was already done.
        const disposers = []
        const own = (result) => {
          if (typeof result === 'function') disposers.push(result)
        }
        const release = () => {
          for (const dispose of disposers) dispose()
          disposers.length = 0
        }

        try {
          own(tabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            title: () => '蒸馏',
            guide: [{
              order: 60,
              title: () => '蒸馏',
              description: () => '查看本会话的步间记录与轮间记录。',
            }],
          }))

          own(injected.slots.inject('sidebar.right.pane.tab', () => injected.slots.register({
            name: 'sidebar.right.pane.tab',
            key: TAB_ID,
            // The seat is declared `scope: "session"` in the host's own
            // registry; that declaration sits on the parent chain under
            // `rightbar.session`, which this plugin does not join, so it was
            // verified by rendering the value before anything depended on it.
            //
            // `sessions` rides along rather than being read from the factory
            // scope: the panel subscribes to the session's event source, and
            // that service is only reachable through an injected context.
            inject: (sessionId) => ({ sessionId, sessions: ctx.get('sessions') }),
          }, (props) => createElement(DistillTab, { ...props, host: 'sidebar' }))))

          own(injected.slots.inject('sidebar.right.pane.tab.title', () => injected.slots.register({
            name: 'sidebar.right.pane.tab.title',
            key: TAB_ID,
          }, () => createElement(DistillTabTitle))))
        } catch (error) {
          release()
          ctx.logger?.warn?.(`[${PLUGIN_ID}] sidebar tab not registered: ${String(error)}`)
          return
        }
        return release
      })

      // A second injection alongside the tab's: the card needs `settingsScope`,
      // which the tab's own scope does not carry. Registered on the namespace
      // rather than in storage of its own -- the settings tab dispatches its
      // cards by namespace, so claiming this key is what makes the card appear.
      ctx.inject(['slots', 'settingsScope'], (scoped) => {
        const scope = scoped.settingsScope.bind({ namespace: SETTINGS_NAMESPACE })
        scoped.slots.inject('settings.plugin.item', () => scoped.slots.register({
          name: 'settings.plugin.item',
          key: SETTINGS_NAMESPACE,
        }, () => createElement(SettingsCard, { scope })))
      })
    }

    // `sessions` is declared because the panel subscribes to the session's
    // event source. `settingsScope` is declared for the settings card, which
    // edits the switches the host serves under SETTINGS_NAMESPACE. The host
    // rejects an undeclared service, so a plain function plugin would have no
    // way to reach either.
    return { apply, name: PLUGIN_ID, inject: ['slots', 'sessions', 'settingsScope'] }
  },
})
