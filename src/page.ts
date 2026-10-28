export type DialogPolicy = { policy: "accept" | "dismiss"; promptText?: string | undefined };
export type PageDialog = { type: string; message: string };
// What a scrollable container still holds out of view: how many controls and, for matching, their labels.
export type ScrollInfo = {
  progress: number;
  below: number;
  above: number;
  belowLabels: string[];
  aboveLabels: string[];
  // A virtualized list: only some of its rows exist in the page, so the labels above are a sample, not all of it.
  virtual?: { rendered: number; total?: number };
};

export type PageRequest =
  | {
      type: "observe";
      dialogs?: DialogPolicy | undefined;
      bind?: string | undefined;
      // What the current step is about; when more controls are on screen than can be offered, these come first.
      goal?: string | undefined;
      depth?: number | undefined;
    }
  | {
      type: "execute";
      dialogs?: DialogPolicy | undefined;
      snapshotId: string;
      actionId: string;
      operation: string;
      targetId?: string | undefined;
      text?: string | undefined;
      expectedSelector?: string | undefined;
    }
  | { type: "receipt"; actionId: string }
  | {
      type: "search";
      dialogs?: DialogPolicy | undefined;
      needle: string;
      sliceMs: number;
      maxScreens: number;
      // "control" looks for a control by its label, "text" for visible text anywhere in a container.
      mode?: "control" | "text" | undefined;
      // Where the control is: words of the row, section or list it sits in.
      within?: string | undefined;
    };

// What one slice of a search found. "more" means the slice ran out of time, not that the page ran out of content.
export type SearchOutcome = {
  status: "found" | "end" | "more" | "budget";
  screens: number;
  container: string;
  label?: string | undefined;
};

export function pageBridge(request: PageRequest): unknown {
  type Candidate = {
    ref: string;
    label: string;
    role: string;
    value?: string;
    currentValue?: string;
    checked?: string;
    scroll?: ScrollInfo;
    bound?: boolean;
    context?: string;
  };
  type Bound = {
    node: HTMLElement;
    option?: HTMLOptionElement | undefined;
    guard: string;
    candidate: Candidate;
    operation: string;
  };
  type Receipt = {
    status: "executed" | "uncertain";
    actionId: string;
    dialogs?: PageDialog[];
    opensTab?: boolean;
    closesTab?: boolean;
  };
  type Registry = {
    documentId: string;
    dialogs: PageDialog[];
    policy: DialogPolicy;
    ids: WeakMap<HTMLElement, string>;
    next: number;
    snapshots: Map<
      string,
      { page: string; targets: Map<string, Bound>; frames: Map<string, { win: Window; snapshotId: string }> }
    >;
    receipts: Map<string, Receipt>;
  };
  const scope = window as Window & { __agentBrowserJev?: Registry };
  const registry = (scope.__agentBrowserJev ??= {
    documentId: crypto.randomUUID(),
    dialogs: [],
    policy: { policy: "accept" },
    ids: new WeakMap(),
    next: 1,
    snapshots: new Map(),
    receipts: new Map(),
  });
  if (request.type === "receipt") return registry.receipts.get(request.actionId) ?? null;
  // A dialog blocks the page until someone answers it, which would freeze the click that opened it.
  // Answer them here by policy, remember what was asked, and keep doing so for the life of the document.
  if (request.dialogs) registry.policy = request.dialogs;
  const scopeWithDialogs = scope as Window & { __agentBrowserJevDialogs?: boolean };
  if (!scopeWithDialogs.__agentBrowserJevDialogs) {
    scopeWithDialogs.__agentBrowserJevDialogs = true;
    const remember = (type: string, message: unknown) => {
      registry.dialogs.push({ type, message: String(message ?? "").slice(0, 300) });
      if (registry.dialogs.length > 20) registry.dialogs.shift();
    };
    window.alert = (message?: unknown) => remember("alert", message);
    window.confirm = (message?: string) => {
      remember("confirm", message);
      return registry.policy.policy === "accept";
    };
    window.prompt = (message?: string, fallback?: string) => {
      remember("prompt", message);
      return registry.policy.policy === "accept" ? (registry.policy.promptText ?? fallback ?? "") : null;
    };
  }
  // Requests in flight count as "not settled yet" for a search; counting starts with the first observation of
  // the document, so a request a click started is seen when the search comes after it.
  type Net = { busy: number; wrapped: boolean };
  const net = ((scope as Window & { __agentBrowserJevNet?: Net }).__agentBrowserJevNet ??= { busy: 0, wrapped: false });
  if (!net.wrapped) {
    net.wrapped = true;
    const originalFetch = window.fetch;
    window.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
      net.busy++;
      return originalFetch.apply(window, args).finally(() => {
        net.busy--;
      });
    } as typeof fetch;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, ...args: Parameters<XMLHttpRequest["send"]>) {
      net.busy++;
      this.addEventListener("loadend", () => void net.busy--, { once: true });
      return originalSend.apply(this, args);
    };
  }
  const roots: Array<Document | ShadowRoot> = [document];
  const nodes: HTMLElement[] = [];
  for (const root of roots)
    for (const node of root.querySelectorAll<HTMLElement>("*")) {
      nodes.push(node);
      if (node.shadowRoot) roots.push(node.shadowRoot);
    }
  const id = (node: HTMLElement) => {
    let value = registry.ids.get(node);
    if (!value) {
      value = `e${registry.next++}`;
      registry.ids.set(node, value);
    }
    return value;
  };
  const visible = (node: HTMLElement) =>
    node.isConnected &&
    !node.closest('[hidden],[inert],[aria-hidden="true"]') &&
    node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const disabled = (node: HTMLElement) =>
    node.matches(":disabled") || Boolean(node.closest('[aria-disabled="true"],[inert]'));
  const terminalInput = (node: HTMLElement): HTMLTextAreaElement | undefined => {
    if (!node.matches('[role="group"][aria-roledescription="terminal"]')) return;
    const inputs = node.querySelectorAll("textarea[aria-label]");
    const input = inputs[0];
    if (
      inputs.length === 1 &&
      input instanceof HTMLTextAreaElement &&
      !input.closest('[hidden],[inert],[aria-hidden="true"],[aria-disabled="true"]') &&
      !input.disabled &&
      !input.readOnly
    )
      return input;
  };
  const name = (node: HTMLElement): string => {
    const root = node.getRootNode();
    const references = (node.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map((key) =>
        root instanceof Document || root instanceof ShadowRoot ? (root.getElementById(key)?.textContent ?? "") : "",
      )
      .join(" ")
      .trim();
    const labels =
      "labels" in node && node.labels instanceof NodeList
        ? Array.from(node.labels)
            .map((label) => label.textContent)
            .join(" ")
        : "";
    return (
      references ||
      node.getAttribute("aria-label") ||
      labels ||
      node.getAttribute("alt") ||
      node.getAttribute("placeholder") ||
      node.innerText ||
      node.getAttribute("title") ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
  };
  const role = (node: HTMLElement): string =>
    (terminalInput(node) ? "textbox" : node.getAttribute("role")) ||
    (node instanceof HTMLSelectElement
      ? "combobox"
      : node instanceof HTMLTextAreaElement || node.isContentEditable
        ? "textbox"
        : node instanceof HTMLInputElement
          ? ["checkbox", "radio"].includes(node.type)
            ? node.type
            : ["submit", "button", "reset"].includes(node.type)
              ? "button"
              : node.type === "search"
                ? "searchbox"
                : "textbox"
          : node instanceof HTMLAnchorElement
            ? "link"
            : node instanceof HTMLButtonElement || node.tagName === "SUMMARY"
              ? "button"
              : "");
  const fieldValue = (node: HTMLElement) =>
    node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement
      ? node.value
      : (terminalInput(node)?.value ?? (node.isContentEditable ? (node.textContent ?? "") : ""));
  const publicValue = (node: HTMLElement) =>
    node instanceof HTMLInputElement && node.type === "password" ? "<redacted>" : fieldValue(node);
  const checked = (node: HTMLElement) =>
    node instanceof HTMLInputElement && ["checkbox", "radio"].includes(node.type)
      ? String(node.checked)
      : node.getAttribute("aria-checked");
  const pageKey = () =>
    JSON.stringify([
      location.href,
      performance.timeOrigin,
      scrollX,
      scrollY,
      innerWidth,
      innerHeight,
      nodes
        .filter(
          (node) =>
            node instanceof HTMLInputElement ||
            node instanceof HTMLSelectElement ||
            node instanceof HTMLTextAreaElement,
        )
        .map((node) => [id(node), fieldValue(node), checked(node), disabled(node)]),
    ]);
  const terminalState = (node: HTMLElement) => {
    const input = terminalInput(node);
    return input ? [id(input), node.innerText.replace(/\s+/g, " ").slice(-12000)] : null;
  };
  const guard = (node: HTMLElement) =>
    JSON.stringify([
      id(node),
      role(node),
      name(node),
      fieldValue(node),
      checked(node),
      node.getAttribute("href"),
      node.getAttribute("aria-expanded"),
      node.getAttribute("aria-selected"),
      node.getAttribute("aria-readonly"),
      "readOnly" in node ? node.readOnly : null,
      disabled(node),
      terminalState(node),
      node instanceof HTMLSelectElement
        ? Array.from(node.options).map((option) => [
            id(option),
            option.value,
            option.label,
            option.selected,
            option.disabled,
            Boolean(option.closest("optgroup[disabled]")),
          ])
        : null,
      node.closest('form,dialog,article,li,tr,[role="dialog"],[role="row"]')?.textContent?.slice(0, 6000) ??
        node.parentElement?.textContent?.slice(0, 2000),
    ]);
  const hit = (node: HTMLElement) => {
    const rect = node.getBoundingClientRect();
    const x = rect.x + rect.width / 2,
      y = rect.y + rect.height / 2;
    if (!rect.width || !rect.height || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
    let target = document.elementFromPoint(x, y);
    while (target?.shadowRoot) {
      const next = target.shadowRoot.elementFromPoint(x, y);
      if (!next || next === target) break;
      target = next;
    }
    while (target) {
      if (target === node || node.contains(target)) return true;
      const root = target.getRootNode();
      target = root instanceof ShadowRoot ? root.host : null;
    }
    return false;
  };

  const parentOf = (node: Element): HTMLElement | null =>
    node.parentElement ?? ((node.getRootNode() as ShadowRoot).host as HTMLElement | undefined) ?? null;
  // What a control sits in, for telling apart controls that say the same: the text of its row, the labels or
  // headings of the sections, lists and dialogs around it, nearest first.
  const placeOf = (node: HTMLElement): string => {
    const clean = (text: string | null | undefined, max: number) =>
      (text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
    const parts: string[] = [];
    let level = 0;
    for (let up = parentOf(node); up && parts.length < 5 && level < 12; up = parentOf(up), level++) {
      const named = up.getAttribute("aria-label") || (up.getAttribute("aria-labelledby") ?? "");
      if (up.matches('tr,li,[role="row"],[role="listitem"]')) parts.push(clean(up.textContent, 120));
      else if (
        named ||
        up.matches('section,article,fieldset,dialog,details,form,[role="dialog"],[role="group"],[role="region"]')
      ) {
        const referenced = named
          .split(/\s+/)
          .map((key) => document.getElementById(key)?.textContent ?? "")
          .join(" ");
        const label = up.getAttribute("aria-label") || referenced.trim();
        parts.push(
          clean(label || up.querySelector("h1,h2,h3,h4,h5,h6,legend,caption,[role=heading]")?.textContent, 80),
        );
      }
    }
    return parts.filter(Boolean).join(" | ");
  };
  // Looks for a control by its label in a page that does not render everything at once: virtualized lists,
  // infinite feeds, long pages. It scrolls the container most likely to hold the label, waits for the page to
  // settle, and looks again, because rows are recycled and appended while it scrolls.
  if (request.type === "search") {
    const search = request;
    return (async (): Promise<SearchOutcome> => {
      const fold = (text: string) =>
        text
          .normalize("NFKD")
          .replace(/\p{M}+/gu, "")
          .toLowerCase();
      const split = (text: string) =>
        fold(text)
          .split(/[^\p{L}\p{N}]+/u)
          .filter(Boolean);
      const wanted = split(search.needle);
      const wantedNumbers = wanted.filter((word) => /^\d+$/.test(word)).map(Number);
      const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
      // A hidden tab never paints, so a frame can be late; never wait for one longer than a moment.
      const frame = () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
          setTimeout(resolve, 60);
        });
      // Quiet means: no DOM change for a moment, nothing marked busy, no request in flight.
      const settle = async (limit = 1500): Promise<boolean> => {
        const started = Date.now();
        let last = started;
        const observer = new MutationObserver(() => void (last = Date.now()));
        observer.observe(document.documentElement, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
        });
        try {
          await frame();
          await frame();
          for (;;) {
            const busy = net.busy > 0 || Boolean(document.querySelector('[aria-busy="true"]'));
            if (!busy && Date.now() - last >= 100) return true;
            if (Date.now() - started > limit) return false;
            await sleep(30);
          }
        } finally {
          observer.disconnect();
        }
      };

      // A page that is still loading (a skeleton, a request in flight) does not yet say what it holds: wait for it
      // before looking, and if it does not settle in this slice, ask to be called again rather than say "not found".
      if (!(await settle(Math.min(search.sliceMs, 8000)))) return { status: "more", screens: 0, container: "" };

      type Area = { node: HTMLElement; page: boolean; label: string; across?: boolean };
      const pageNode = (document.scrollingElement ?? document.documentElement) as HTMLElement;
      const areas: Area[] = [];
      if (pageNode.scrollHeight > innerHeight + 4) areas.push({ node: pageNode, page: true, label: "Page" });
      for (const node of nodes) {
        if (node === document.body || node === document.documentElement || areas.length >= 40) continue;
        const style = getComputedStyle(node);
        const scrolls = ["auto", "scroll", "overlay"];
        const label =
          node.getAttribute("aria-label") || (node.id ? `Scrollable #${node.id.slice(0, 20)}` : "Scrollable area");
        if (!visible(node)) continue;
        if (node.scrollHeight > node.clientHeight + 4 && node.clientHeight >= 40 && scrolls.includes(style.overflowY))
          areas.push({ node, page: false, label });
        // A container that scrolls sideways is searched along its width.
        if (node.scrollWidth > node.clientWidth + 4 && node.clientWidth >= 40 && scrolls.includes(style.overflowX))
          areas.push({ node, page: false, label, across: true });
      }
      // Only the controls that hold no other control: a grid or a row is named by all the text inside it, and
      // would match every label of the rows it holds.
      const interactive = 'a[href],button,input,textarea,select,summary,[contenteditable="true"],[role]';
      const controls = (area: Area) =>
        Array.from((area.page ? document : area.node).querySelectorAll<HTMLElement>(interactive))
          .filter((node) => !node.querySelector(interactive) && visible(node))
          .flatMap((node) => {
            const label = name(node);
            return label ? [{ node, label }] : [];
          });
      const covers = (label: string) => {
        const have = new Set(split(label));
        return wanted.every((word) => have.has(word));
      };
      const overlap = (label: string) => {
        const have = new Set(split(label));
        return wanted.filter((word) => have.has(word)).length / wanted.length;
      };
      // Text mode: the wanted text is looked for in what the container shows, not in the labels of its controls.
      const textMode = search.mode === "text";
      const squash = (text: string) => fold(text).replace(/\s+/g, " ").trim();
      const wantedText = squash(search.needle);
      const textHit = (area: Area): { node: HTMLElement; label: string } | undefined => {
        const root = area.page ? document.body : area.node;
        if (!squash(root.innerText).includes(wantedText)) return undefined;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let at = walker.nextNode(); at; at = walker.nextNode()) {
          const parent = at.parentElement;
          if (parent && squash(at.textContent ?? "").includes(wantedText) && visible(parent))
            return { node: parent, label: search.needle };
        }
        return { node: root, label: search.needle };
      };
      // A control in the place the step asked for: the words of the row or section are among those around it.
      const wantedPlace = split(search.within ?? "");
      const mentionsPlace = (text: string) => {
        const have = new Set(split(text));
        return wantedPlace.every((word) => have.has(word));
      };
      // A control with nothing around it that the page can name is not known to be elsewhere.
      const inPlace = (node: HTMLElement) => {
        const around = placeOf(node);
        return !wantedPlace.length || !around || mentionsPlace(around);
      };
      const hit = (area: Area) =>
        textMode ? textHit(area) : controls(area).find((item) => covers(item.label) && inPlace(item.node));
      if (!wanted.length || !areas.length) {
        const only = pageNode.scrollHeight > innerHeight + 4 ? "Page" : "";
        return {
          status: hit({ node: pageNode, page: true, label: "Page" }) ? "found" : "end",
          screens: 0,
          container: only,
        };
      }

      // The container whose controls look most like the wanted one; the smallest of equals, since the page
      // contains every other container. With no resemblance anywhere, the page, else the biggest container.
      const scored = areas.map((area) => ({
        area,
        // A container named like the place asked for ("in the Invoices list") is the one to look in.
        score:
          (wantedPlace.length && mentionsPlace(area.label) ? 1 : 0) +
          (textMode
            ? overlap((area.page ? document.body : area.node).innerText.slice(0, 50_000))
            : Math.max(0, ...controls(area).map((item) => overlap(item.label)))),
      }));
      const best = Math.max(...scored.map((item) => item.score));
      const pool = best > 0 ? scored.filter((item) => item.score === best) : scored;
      const area = (
        best > 0
          ? pool.sort((a, b) => a.area.node.clientHeight - b.area.node.clientHeight)
          : pool.sort(
              (a, b) =>
                Number(b.area.page) - Number(a.area.page) || b.area.node.clientHeight - a.area.node.clientHeight,
            )
      )[0]!.area;
      const node = area.node;
      const across = area.across === true;
      const top = () => (across ? node.scrollLeft : area.page ? scrollY : node.scrollTop);
      const height = () =>
        across ? node.scrollWidth : area.page ? document.documentElement.scrollHeight : node.scrollHeight;
      const view = () => (across ? node.clientWidth : area.page ? innerHeight : node.clientHeight);
      const limit = () => Math.max(0, height() - view());
      const go = (y: number) => {
        if (across) node.scrollTo({ left: y, behavior: "instant" });
        else if (area.page) window.scrollTo({ top: y, behavior: "instant" });
        else node.scrollTo({ top: y, behavior: "instant" });
      };
      // A control's place along the container's content, which does not change while the container scrolls.
      const place = (control: HTMLElement) =>
        across
          ? control.getBoundingClientRect().left + node.scrollLeft - node.getBoundingClientRect().left
          : control.getBoundingClientRect().top +
            (area.page ? scrollY : node.scrollTop - node.getBoundingClientRect().top);
      const find = () => hit(area);

      // Rows often carry a number (order #08731, item 170) and are sorted by it. Two rows give the rate, and
      // the rate says where the wanted number is, which beats scrolling a screen at a time through 10,000 rows.
      const aim = (items: ReturnType<typeof controls>): number | null => {
        for (const [index, target] of wantedNumbers.entries()) {
          const samples = items
            .flatMap(({ node: control, label }) => {
              const value = split(label)
                .filter((word) => /^\d+$/.test(word))
                .map(Number)[index];
              return value === undefined ? [] : [{ y: place(control), n: value }];
            })
            .sort((a, b) => a.y - b.y);
          const first = samples[0],
            last = samples.at(-1);
          if (!first || !last || first.n === last.n || first.y === last.y) continue;
          const ascending = last.n > first.n;
          const sorted = samples.every(
            (sample, at) => at === 0 || (ascending ? sample.n >= samples[at - 1]!.n : sample.n <= samples[at - 1]!.n),
          );
          if (!sorted) continue;
          const near = samples.reduce((a, b) => (Math.abs(b.n - target) < Math.abs(a.n - target) ? b : a));
          return near.y + (target - near.n) / ((last.n - first.n) / (last.y - first.y));
        }
        return null;
      };

      // The control found, brought to the middle of its container. Recycled rows can change under it while it
      // scrolls, so look it up again until it is where it was brought to.
      const arrive = async (): Promise<string | null> => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const item = find();
          if (!item) return null;
          item.node.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
          await settle();
          const again = find();
          if (!again) continue;
          const rect = again.node.getBoundingClientRect();
          if (
            rect.top >= 0 &&
            rect.bottom <= innerHeight &&
            rect.left >= 0 &&
            rect.right <= innerWidth &&
            rect.height > 0
          )
            return again.label;
        }
        return find()?.label ?? null;
      };

      const deadline = Date.now() + search.sliceMs;
      let screens = 0,
        stuck = 0,
        sureNotHere = 0;
      for (;;) {
        const items = controls(area);
        if (find()) {
          const label = await arrive();
          if (label !== null) return { status: "found", screens, container: area.label, label };
        }
        if (screens >= search.maxScreens) return { status: "budget", screens, container: area.label };
        if (Date.now() >= deadline) return { status: "more", screens, container: area.label };
        const here = top();
        const heightBefore = height();
        const aimed = aim(items);
        // Rows that are rendered beyond the visible ones say how far a step can go without skipping any.
        const places = items.map((item) => place(item.node));
        const span = places.length ? Math.max(...places) - Math.min(...places) : 0;
        const step = Math.min(view() * 5, Math.max(60, view() * 0.8, span * 0.8));
        let next = here + step;
        if (aimed !== null) {
          const goal = Math.min(limit(), Math.max(0, aimed - view() / 2));
          // The estimate says "right here" and the row is not here: the sorted list does not have it.
          if (Math.abs(goal - here) <= 4 && goal < limit()) {
            if (++sureNotHere >= 2) return { status: "end", screens, container: area.label };
          } else sureNotHere = 0;
          if (Math.abs(goal - here) > 4) next = goal;
        }
        go(Math.min(limit(), next));
        screens++;
        await settle();
        // At the bottom with nothing new for a moment and again after a grace period: this is the end.
        if (Math.abs(top() - here) < 1 && height() === heightBefore) {
          if (++stuck >= 2) return { status: "end", screens, container: area.label };
          await sleep(700);
        } else stuck = 0;
      }
    })();
  }

  if (request.type === "execute") {
    const oldReceipt = registry.receipts.get(request.actionId);
    if (oldReceipt) return oldReceipt;
    const snapshot = registry.snapshots.get(request.snapshotId);
    if (!snapshot || snapshot.page !== pageKey()) return { status: "stale", reason: "document-or-form-changed" };
    // A target inside a frame is "<frame>/<target>": the frame has its own copy of this script, which knows it.
    const slash = request.targetId?.indexOf("/") ?? -1;
    if (request.targetId && slash > 0) {
      const frame = snapshot.frames.get(request.targetId.slice(0, slash));
      if (!frame) return { status: "stale", reason: "frame-not-observed" };
      try {
        return (frame.win as Window & typeof globalThis).eval(
          `(${pageBridge.toString()})(${JSON.stringify({ ...request, snapshotId: frame.snapshotId, targetId: request.targetId.slice(slash + 1) })})`,
        );
      } catch {
        return { status: "stale", reason: "frame-unavailable" };
      }
    }
    const bound = request.targetId ? snapshot.targets.get(`${request.operation}:${request.targetId}`) : undefined;
    if (request.expectedSelector && bound) {
      try {
        if (!bound.node.matches(request.expectedSelector))
          return { status: "stale", reason: "target-does-not-match-test-binding" };
      } catch {
        return { status: "stale", reason: "invalid-test-selector" };
      }
    }
    if (
      request.targetId &&
      (!bound ||
        !visible(bound.node) ||
        disabled(bound.node) ||
        guard(bound.node) !== bound.guard ||
        (bound.option &&
          (!bound.option.isConnected || bound.option.disabled || Boolean(bound.option.closest("optgroup[disabled]")))))
    )
      return { status: "stale", reason: "target-changed-or-covered" };
    if (request.targetId && bound && !hit(bound.node)) {
      // A sticky header or a toast can sit over a control that is on screen. Bring it to the middle and look
      // again: a control still covered then (a modal, say) is not one to click.
      bound.node.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      if (!hit(bound.node)) return { status: "stale", reason: "target-changed-or-covered" };
    }
    if (
      ![
        "CLICK",
        "TYPE_TEXT",
        "SELECT",
        "CHECK",
        "UNCHECK",
        "PRESS_ENTER",
        "SCROLL_DOWN",
        "SCROLL_UP",
        "SCROLL_LEFT",
        "SCROLL_RIGHT",
        "WAIT",
      ].includes(request.operation) ||
      (["CLICK", "TYPE_TEXT", "SELECT", "CHECK", "UNCHECK", "PRESS_ENTER"].includes(request.operation) && !bound)
    )
      return { status: "stale", reason: "operation-not-observed" };
    if (request.operation === "WAIT")
      return new Promise((resolve) => {
        const finish = () => {
          observer.disconnect();
          clearTimeout(timer);
          const receipt: Receipt = { status: "executed", actionId: request.actionId };
          registry.receipts.set(request.actionId, receipt);
          resolve(receipt);
        };
        const observer = new MutationObserver(finish);
        const timer = setTimeout(finish, 500);
        observer.observe(document.documentElement, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
        });
      });
    registry.receipts.set(request.actionId, { status: "uncertain", actionId: request.actionId });
    const dialogsBefore = registry.dialogs.length;
    // An action opens a tab when it calls window.open or activates a link or form aimed at a new window.
    let opens = 0;
    const originalOpen = window.open;
    window.open = function (this: Window, ...args: Parameters<typeof window.open>) {
      opens++;
      return originalOpen.apply(this, args);
    };
    let closes = 0;
    const originalClose = window.close;
    window.close = function (this: Window) {
      closes++;
      // Closing now would destroy the page before this call can return its receipt.
      setTimeout(() => originalClose.apply(this), 50);
    };
    const aimed = (element: Element | null | undefined) => {
      const target = element?.closest("a[target],form[target]")?.getAttribute("target")?.toLowerCase() ?? "";
      return target !== "" && !["_self", "_top", "_parent"].includes(target);
    };
    try {
      const node = bound?.node;
      switch (request.operation) {
        case "CLICK":
          if (node) HTMLElement.prototype.click.call(node);
          break;
        case "CHECK":
        case "UNCHECK":
          if (!(node instanceof HTMLInputElement) || node.type !== "checkbox") throw new Error("Unsupported checkbox");
          if (node.checked !== (request.operation === "CHECK")) HTMLElement.prototype.click.call(node);
          break;
        case "TYPE_TEXT": {
          const terminal = node ? terminalInput(node) : undefined;
          const field = terminal ?? node;
          if (
            !field ||
            request.text === undefined ||
            ((field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) && field.readOnly)
          )
            throw new Error("Unsupported field");
          if (terminal) field.focus({ preventScroll: true });
          if (!field.isConnected) throw new Error("Field detached during focus");
          if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
            const prototype =
              field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
            if (!setter) throw new Error("Unsupported setter");
            setter.call(field, request.text);
          } else if (field.isContentEditable) field.textContent = request.text;
          else throw new Error("Unsupported field");
          field.dispatchEvent(
            new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: request.text }),
          );
          field.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
          break;
        }
        case "SELECT":
          if (
            !(node instanceof HTMLSelectElement) ||
            !bound?.option ||
            node.options[bound.option.index] !== bound.option
          )
            throw new Error("Unsupported option");
          node.selectedIndex = bound.option.index;
          node.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
          node.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
          break;
        case "PRESS_ENTER": {
          const input = node ? terminalInput(node) : undefined;
          if (input) {
            input.focus({ preventScroll: true });
            if (!input.isConnected) throw new Error("Terminal input detached during focus");
            for (const type of ["keydown", "keyup"])
              input.dispatchEvent(
                new KeyboardEvent(type, {
                  key: "Enter",
                  code: "Enter",
                  keyCode: 13,
                  which: 13,
                  bubbles: true,
                  composed: true,
                  cancelable: true,
                }),
              );
            break;
          }
          const form = node?.closest("form");
          if (!(form instanceof HTMLFormElement)) throw new Error("No observed form");
          form.requestSubmit();
          break;
        }
        case "SCROLL_LEFT":
        case "SCROLL_RIGHT": {
          const direction = request.operation === "SCROLL_RIGHT" ? 1 : -1;
          if (node && node !== document.scrollingElement && node !== document.documentElement)
            node.scrollBy({ left: direction * Math.max(60, node.clientWidth * 0.8), behavior: "instant" });
          else window.scrollBy(direction * 500, 0);
          break;
        }
        case "SCROLL_DOWN":
        case "SCROLL_UP": {
          const direction = request.operation === "SCROLL_DOWN" ? 1 : -1;
          // A container scrolls by most of its own height; the page, or no target at all, by a fixed step.
          if (node && node !== document.scrollingElement && node !== document.documentElement)
            node.scrollBy({ top: direction * Math.max(60, node.clientHeight * 0.8), behavior: "instant" });
          else window.scrollBy(0, direction * 500);
          break;
        }
      }
      const asked = registry.dialogs.slice(Math.min(dialogsBefore, registry.dialogs.length));
      const receipt: Receipt = {
        status: "executed",
        actionId: request.actionId,
        ...(asked.length ? { dialogs: asked } : {}),
        ...(opens > 0 || aimed(bound?.node) ? { opensTab: true } : {}),
        ...(closes > 0 ? { closesTab: true } : {}),
      };
      registry.receipts.set(request.actionId, receipt);
      if (registry.receipts.size > 250) {
        const first = registry.receipts.keys().next().value;
        if (first) registry.receipts.delete(first);
      }
      return receipt;
    } catch {
      return { status: "uncertain", actionId: request.actionId };
    } finally {
      window.open = originalOpen;
      window.close = originalClose;
    }
  }

  // Scrollable containers (lists, panels, dialogs). Controls inside one can be out of view even when the
  // page itself does not scroll, so they are reported as hidden, with their labels, instead of as targets.
  type Scroller = {
    node: HTMLElement;
    box: DOMRect;
    below: string[];
    above: string[];
    belowCount: number;
    aboveCount: number;
    // It also scrolls sideways: its clipped controls are hidden, and it is offered to scroll left and right.
    wide: boolean;
  };
  const scrollers = new Map<HTMLElement, Scroller>();
  for (const node of nodes) {
    if (node === document.body || node === document.documentElement || scrollers.size >= 12) continue;
    const style = getComputedStyle(node);
    const scrolls = ["auto", "scroll", "overlay"];
    const tall =
      node.scrollHeight > node.clientHeight + 4 && node.clientHeight >= 40 && scrolls.includes(style.overflowY);
    const wide = node.scrollWidth > node.clientWidth + 4 && node.clientWidth >= 40 && scrolls.includes(style.overflowX);
    if ((!tall && !wide) || !visible(node)) continue;
    scrollers.set(node, {
      node,
      box: node.getBoundingClientRect(),
      below: [],
      above: [],
      belowCount: 0,
      aboveCount: 0,
      wide,
    });
  }
  // Where a rectangle sits against the containers around it: null when every one of them shows it.
  const cutBy = (node: Element, rect: DOMRect): { scroller: Scroller; side: "above" | "below" | "side" } | null => {
    if (!scrollers.size) return null;
    for (let parent = parentOf(node); parent; parent = parentOf(parent)) {
      const scroller = scrollers.get(parent);
      if (!scroller) continue;
      if (rect.bottom <= scroller.box.top) return { scroller, side: "above" };
      if (rect.top >= scroller.box.bottom) return { scroller, side: "below" };
      if (rect.right <= scroller.box.left || rect.left >= scroller.box.right) return { scroller, side: "side" };
    }
    return null;
  };
  // The step may name its control by selector; the targets that match it say so, and execute re-checks it.
  const bindsStep = (node: HTMLElement) => {
    if (request.type !== "observe" || !request.bind) return false;
    try {
      return node.matches(request.bind);
    } catch {
      return false;
    }
  };
  const targets: Record<string, Record<string, Candidate>> = {};
  const boundTargets = new Map<string, Bound>();
  const elements: Array<{
    index: string;
    label: string;
    role: string;
    value: string;
    operations: string[];
    checked?: string;
  }> = [];
  const add = (
    operation: string,
    targetId: string,
    node: HTMLElement,
    candidate: Candidate,
    option?: HTMLOptionElement,
  ) => {
    (targets[operation] ??= {})[targetId] = candidate;
    boundTargets.set(`${operation}:${targetId}`, { node, operation, candidate, option, guard: guard(node) });
  };
  // Every control on screen is collected first; only then are up to 150 chosen, the ones that best match the goal
  // of the step, so a crowded screen cannot push the control the step needs out of the list.
  const eligible: Array<{ node: HTMLElement; nodeRole: string; label: string }> = [];
  // Controls the page has outside the visible area, which the model is told about so it can scroll to them.
  const outside: Array<{ node: HTMLElement; where: string }> = [];
  for (const node of nodes) {
    if (
      !node.matches('a[href],button,input,textarea,select,summary,[contenteditable="true"],[role]') ||
      !visible(node) ||
      disabled(node)
    )
      continue;
    if (node instanceof HTMLInputElement && ["hidden", "file", "color", "range"].includes(node.type)) continue;
    const rect = node.getBoundingClientRect();
    const cut = rect.width && rect.height ? cutBy(node, rect) : null;
    if (cut) {
      // Scrolled out of its container: not clickable now, but the container can reveal it.
      const hiddenRole = cut.side === "side" ? "" : role(node);
      if (hiddenRole) {
        const side = cut.side === "above" ? "above" : "below";
        cut.scroller[`${side}Count`]++;
        if (cut.scroller[side].length < 60) cut.scroller[side].push((name(node) || hiddenRole).slice(0, 40));
      }
      continue;
    }
    if (
      !rect.width ||
      !rect.height ||
      rect.bottom <= 0 ||
      rect.right <= 0 ||
      rect.top >= innerHeight ||
      rect.left >= innerWidth
    ) {
      if (rect.width && rect.height && outside.length < 2000)
        outside.push({
          node,
          where:
            rect.bottom <= 0 ? "above" : rect.top >= innerHeight ? "below" : rect.right <= 0 ? "left of" : "right of",
        });
      continue;
    }
    const nodeRole = role(node);
    if (!nodeRole) continue;
    eligible.push({ node, nodeRole, label: name(node) || nodeRole });
  }
  const goalWords = new Set(
    (request.type === "observe" ? (request.goal ?? "") : "")
      .normalize("NFKD")
      .replace(/\p{M}+/gu, "")
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  );
  const match = (label: string) => {
    if (!goalWords.size) return 0;
    const have = new Set(
      label
        .normalize("NFKD")
        .replace(/\p{M}+/gu, "")
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean),
    );
    let shared = 0;
    for (const word of have) if (goalWords.has(word)) shared++;
    return shared / Math.max(1, have.size);
  };
  const chosen =
    eligible.length <= 150
      ? eligible
      : eligible
          .map((item, order) => ({ item, order, score: match(item.label) }))
          .sort((a, b) => b.score - a.score || a.order - b.order)
          .slice(0, 150)
          .sort((a, b) => a.order - b.order)
          .map(({ item }) => item);
  const hints = outside
    .flatMap(({ node, where }, order) => {
      const kind = role(node);
      if (!kind) return [];
      const label = name(node) || kind;
      return [{ order, score: match(label), text: `${label.slice(0, 80)} (${kind}, ${where} the view)` }];
    })
    .sort((a, b) => b.score - a.score || a.order - b.order);
  const offscreen = hints.slice(0, 60).map((hint) => hint.text);
  const offscreenMore = Math.max(0, hints.length - offscreen.length);
  for (const { node, nodeRole, label } of chosen) {
    const nodeId = id(node);
    const value = publicValue(node),
      state = checked(node);
    const candidate: Candidate = {
      ref: nodeId,
      label,
      role: nodeRole,
      currentValue: value,
      ...(state === null ? {} : { checked: state }),
      ...(bindsStep(node) ? { bound: true } : {}),
      ...(placeOf(node) ? { context: placeOf(node) } : {}),
    };
    const operations: string[] = [];
    if (node instanceof HTMLSelectElement) {
      for (const [index, option] of Array.from(node.options).entries())
        if (!option.selected && !option.disabled && !option.closest("optgroup[disabled]")) {
          add(
            "SELECT",
            `${nodeId}:${index}`,
            node,
            { ...candidate, label: `${label} → ${option.label}`, value: option.value },
            option,
          );
        }
      operations.push("SELECT");
    } else if (node instanceof HTMLInputElement && node.type === "checkbox") {
      add("CLICK", nodeId, node, candidate);
      operations.push("CLICK");
    } else {
      const editable =
        Boolean(terminalInput(node)) ||
        node instanceof HTMLTextAreaElement ||
        node.isContentEditable ||
        (node instanceof HTMLInputElement && !["button", "submit", "reset", "radio", "checkbox"].includes(node.type));
      if (
        editable &&
        !(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement
          ? node.readOnly
          : node.getAttribute("aria-readonly") === "true")
      ) {
        add("TYPE_TEXT", nodeId, node, candidate);
        operations.push("TYPE_TEXT");
      }
      if (
        [
          "button",
          "link",
          "combobox",
          "checkbox",
          "radio",
          "switch",
          "tab",
          "option",
          "menuitem",
          "menuitemcheckbox",
          "menuitemradio",
          "treeitem",
          "gridcell",
        ].includes(nodeRole) &&
        // A data grid wraps its buttons in cells; the button is the target, the cell would only repeat its label.
        !(
          nodeRole === "gridcell" &&
          node.querySelector('a[href],button,input,select,textarea,summary,[role="button"],[role="link"]')
        )
      ) {
        add("CLICK", nodeId, node, candidate);
        operations.push("CLICK");
      }
      if (editable && (node.closest("form") || terminalInput(node))) {
        add("PRESS_ENTER", nodeId, node, candidate);
        operations.push("PRESS_ENTER");
      }
    }
    elements.push({
      index: nodeId,
      label,
      role: nodeRole,
      value,
      operations,
      ...(state === null ? {} : { checked: state }),
    });
  }
  const containerLabel = (node: HTMLElement): string => {
    const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
    const referenced = (node.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map((key) => document.getElementById(key)?.textContent ?? "")
      .join(" ");
    const own = clean(node.getAttribute("aria-label")) || clean(referenced) || clean(node.getAttribute("title"));
    if (own) return own;
    const heading = clean(node.querySelector("h1,h2,h3,h4,h5,h6,legend,caption,[role=heading]")?.textContent);
    if (heading) return heading;
    const before = node.previousElementSibling;
    if (before && /^(H[1-6]|LABEL|LEGEND)$/.test(before.tagName) && clean(before.textContent))
      return clean(before.textContent);
    const kind =
      node.getAttribute("role") ??
      (["UL", "OL"].includes(node.tagName)
        ? "list"
        : node.tagName === "TABLE"
          ? "table"
          : node.tagName === "DIALOG"
            ? "dialog"
            : "area");
    return `Scrollable ${kind}${node.id ? ` #${node.id.slice(0, 20)}` : ""}`;
  };
  // A container the model can scroll: SCROLL_DOWN / SCROLL_UP gain targets, and the page itself is offered
  // as one more ("Page") so choosing between a container and the whole page stays possible.
  for (const scroller of scrollers.values()) {
    const { node, box } = scroller;
    if (box.bottom <= 0 || box.top >= innerHeight || box.right <= 0 || box.left >= innerWidth || cutBy(node, box))
      continue;
    if (scroller.wide) {
      const sideways: Candidate = {
        ref: id(node),
        label: containerLabel(node),
        role: "scrollable",
        currentValue: `${Math.round((100 * node.scrollLeft) / Math.max(1, node.scrollWidth - node.clientWidth))}% scrolled sideways`,
      };
      if (node.scrollLeft + node.clientWidth < node.scrollWidth - 2) add("SCROLL_RIGHT", sideways.ref, node, sideways);
      if (node.scrollLeft > 0) add("SCROLL_LEFT", sideways.ref, node, sideways);
    }
    const canDown = node.scrollTop + node.clientHeight < node.scrollHeight - 2;
    const canUp = node.scrollTop > 0;
    if (!canDown && !canUp) continue;
    const nodeId = id(node);
    const progress = Math.round((100 * node.scrollTop) / Math.max(1, node.scrollHeight - node.clientHeight));
    // Rows that exist against rows the container says it has (aria-rowcount), or against how tall its content is.
    const rows = Array.from(
      node.querySelectorAll<HTMLElement>('[role="row"],[role="listitem"],[role="option"],li,tr'),
    ).slice(0, 400);
    const declared = Number(
      node.getAttribute("aria-rowcount") ??
        node.querySelector("[aria-rowcount]")?.getAttribute("aria-rowcount") ??
        node.querySelector("[aria-setsize]")?.getAttribute("aria-setsize") ??
        NaN,
    );
    const rowsHeight = rows.reduce((sum, row) => sum + row.getBoundingClientRect().height, 0);
    const virtual =
      rows.length >= 3 && ((Number.isFinite(declared) && declared > rows.length) || rowsHeight * 3 < node.scrollHeight);
    const candidate: Candidate = {
      ref: nodeId,
      label: containerLabel(node),
      role: "scrollable",
      currentValue: `${progress}% scrolled`,
      scroll: {
        progress,
        below: scroller.belowCount,
        above: scroller.aboveCount,
        belowLabels: scroller.below,
        aboveLabels: scroller.above,
        ...(virtual
          ? { virtual: { rendered: rows.length, ...(Number.isFinite(declared) ? { total: declared } : {}) } }
          : {}),
      },
    };
    if (canDown) add("SCROLL_DOWN", nodeId, node, candidate);
    if (canUp) add("SCROLL_UP", nodeId, node, candidate);
  }
  if (targets.SCROLL_DOWN || targets.SCROLL_UP) {
    const root = (document.scrollingElement ?? document.documentElement) as HTMLElement;
    const range = Math.max(1, document.documentElement.scrollHeight - innerHeight);
    const page: Candidate = {
      ref: "page",
      label: "Page",
      role: "scrollable",
      currentValue: `${Math.round((100 * scrollY) / range)}% scrolled`,
    };
    if (scrollY + innerHeight < document.documentElement.scrollHeight - 2) add("SCROLL_DOWN", "page", root, page);
    if (scrollY > 0) add("SCROLL_UP", "page", root, page);
  }
  const words: string[] = [];
  let length = 0;
  for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let textNode: Node | null;
    while ((textNode = walker.nextNode()) && length < 12_000) {
      const parent = textNode.parentElement,
        value = textNode.textContent?.trim();
      if (!parent || !value || parent.closest("script,style,noscript,template") || !visible(parent)) continue;
      const range = document.createRange();
      range.selectNodeContents(textNode);
      const rect = range.getBoundingClientRect();
      if (
        rect.width &&
        rect.height &&
        rect.bottom > 0 &&
        rect.top < innerHeight &&
        rect.right > 0 &&
        rect.left < innerWidth &&
        !(scrollers.size && cutBy(parent, rect))
      ) {
        words.push(value);
        length += value.length;
      }
    }
  }
  // Same-site frames are documents of their own, with their own elements. Each is read by its own copy of this
  // script (so its nodes are checked and clicked in their own realm) and merged in with the frame's id as a prefix.
  const frames = new Map<string, { win: Window; snapshotId: string }>();
  const frameDepth = request.type === "observe" ? (request.depth ?? 0) : 0;
  if (frameDepth < 3) {
    for (const frame of nodes) {
      if (!(frame instanceof HTMLIFrameElement) || !visible(frame)) continue;
      const box = frame.getBoundingClientRect();
      if (
        !box.width ||
        !box.height ||
        box.bottom <= 0 ||
        box.top >= innerHeight ||
        box.right <= 0 ||
        box.left >= innerWidth
      )
        continue;
      type Seen = {
        targets: Record<string, Record<string, Candidate>>;
        elements: typeof elements;
        text: string;
        snapshotId: string;
      };
      let seen: Seen;
      try {
        const win = frame.contentWindow as (Window & typeof globalThis) | null;
        if (!win?.document) continue;
        seen = win.eval(
          `(${pageBridge.toString()})(${JSON.stringify({
            type: "observe",
            dialogs: request.type === "observe" ? request.dialogs : undefined,
            bind: request.type === "observe" ? request.bind : undefined,
            depth: frameDepth + 1,
          })})`,
        ) as Seen;
        const prefix = id(frame);
        frames.set(prefix, { win, snapshotId: seen.snapshotId });
        for (const [operation, group] of Object.entries(seen.targets))
          for (const [targetId, candidate] of Object.entries(group))
            (targets[operation] ??= {})[`${prefix}/${targetId}`] = {
              ...candidate,
              ref: `${prefix}/${candidate.ref}`,
              ...(candidate.ref === "page" ? { label: "Frame page" } : {}),
            };
        for (const element of seen.elements)
          if (elements.length < 150) elements.push({ ...element, index: `${prefix}/${element.index}` });
        if (seen.text) words.push(seen.text);
      } catch {
        // A frame from another site, or one that is gone, stays an opaque box.
      }
    }
  }
  const text = words.join("\n").slice(0, 12_000);
  const tree =
    elements
      .map(
        (element) =>
          `- ${element.role} ${JSON.stringify(element.label)} [ref=${element.index}${element.checked === undefined ? "" : `, checked=${element.checked}`}]: ${element.value}`,
      )
      .join("\n") +
    "\n" +
    text;
  const snapshotId = crypto.randomUUID();
  registry.snapshots.set(snapshotId, { page: pageKey(), targets: boundTargets, frames });
  if (registry.snapshots.size > 4) {
    const first = registry.snapshots.keys().next().value;
    if (first) registry.snapshots.delete(first);
  }
  const controls = [
    "WAIT",
    "DONE",
    "BLOCKED",
    ...(scrollY > 0 ? ["SCROLL_UP"] : []),
    ...(scrollY + innerHeight < document.documentElement.scrollHeight - 2 ? ["SCROLL_DOWN"] : []),
    ...(scrollX > 0 ? ["SCROLL_LEFT"] : []),
    ...(scrollX + innerWidth < document.documentElement.scrollWidth - 2 ? ["SCROLL_RIGHT"] : []),
  ];
  return {
    url: location.href,
    title: document.title,
    tree,
    text,
    elements,
    targets,
    controls,
    offscreen,
    offscreenMore,
    documentId: registry.documentId,
    snapshotId,
  };
}

export function pageExpression(request: PageRequest): string {
  return `(${pageBridge.toString()})(${JSON.stringify(request)})`;
}
