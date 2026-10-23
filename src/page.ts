export type PageRequest =
  | { type: "observe" }
  | {
      type: "execute";
      snapshotId: string;
      actionId: string;
      operation: string;
      targetId?: string | undefined;
      text?: string | undefined;
      expectedSelector?: string | undefined;
    }
  | { type: "receipt"; actionId: string };

export function pageBridge(request: PageRequest): unknown {
  type Candidate = {
    ref: string;
    label: string;
    role: string;
    value?: string;
    currentValue?: string;
    checked?: string;
  };
  type Bound = {
    node: HTMLElement;
    option?: HTMLOptionElement | undefined;
    guard: string;
    candidate: Candidate;
    operation: string;
  };
  type Receipt = { status: "executed" | "uncertain"; actionId: string };
  type Registry = {
    documentId: string;
    ids: WeakMap<HTMLElement, string>;
    next: number;
    snapshots: Map<string, { page: string; targets: Map<string, Bound> }>;
    receipts: Map<string, Receipt>;
  };
  const scope = window as Window & { __agentBrowserJev?: Registry };
  const registry = (scope.__agentBrowserJev ??= {
    documentId: crypto.randomUUID(),
    ids: new WeakMap(),
    next: 1,
    snapshots: new Map(),
    receipts: new Map(),
  });
  if (request.type === "receipt") return registry.receipts.get(request.actionId) ?? null;
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

  if (request.type === "execute") {
    const oldReceipt = registry.receipts.get(request.actionId);
    if (oldReceipt) return oldReceipt;
    const snapshot = registry.snapshots.get(request.snapshotId);
    if (!snapshot || snapshot.page !== pageKey()) return { status: "stale", reason: "document-or-form-changed" };
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
          (!bound.option.isConnected ||
            bound.option.disabled ||
            Boolean(bound.option.closest("optgroup[disabled]")))) ||
        !hit(bound.node))
    )
      return { status: "stale", reason: "target-changed-or-covered" };
    if (
      !["CLICK", "TYPE_TEXT", "SELECT", "CHECK", "UNCHECK", "PRESS_ENTER", "SCROLL_DOWN", "SCROLL_UP", "WAIT"].includes(
        request.operation,
      ) ||
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
        case "SCROLL_DOWN":
          window.scrollBy(0, 500);
          break;
        case "SCROLL_UP":
          window.scrollBy(0, -500);
          break;
      }
      const receipt: Receipt = { status: "executed", actionId: request.actionId };
      registry.receipts.set(request.actionId, receipt);
      if (registry.receipts.size > 250) {
        const first = registry.receipts.keys().next().value;
        if (first) registry.receipts.delete(first);
      }
      return receipt;
    } catch {
      return { status: "uncertain", actionId: request.actionId };
    }
  }

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
  for (const node of nodes) {
    if (
      !node.matches('a[href],button,input,textarea,select,summary,[contenteditable="true"],[role]') ||
      !visible(node) ||
      disabled(node)
    )
      continue;
    if (node instanceof HTMLInputElement && ["hidden", "file", "color", "range"].includes(node.type)) continue;
    const rect = node.getBoundingClientRect();
    if (
      !rect.width ||
      !rect.height ||
      rect.bottom <= 0 ||
      rect.right <= 0 ||
      rect.top >= innerHeight ||
      rect.left >= innerWidth
    )
      continue;
    const nodeRole = role(node);
    if (!nodeRole) continue;
    const nodeId = id(node),
      label = name(node) || nodeRole;
    const value = publicValue(node),
      state = checked(node);
    const candidate: Candidate = {
      ref: nodeId,
      label,
      role: nodeRole,
      currentValue: value,
      ...(state === null ? {} : { checked: state }),
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
        ].includes(nodeRole)
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
    if (elements.length >= 150) break;
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
        rect.left < innerWidth
      ) {
        words.push(value);
        length += value.length;
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
  registry.snapshots.set(snapshotId, { page: pageKey(), targets: boundTargets });
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
  ];
  return {
    url: location.href,
    title: document.title,
    tree,
    text,
    elements,
    targets,
    controls,
    documentId: registry.documentId,
    snapshotId,
  };
}

export function pageExpression(request: PageRequest): string {
  return `(${pageBridge.toString()})(${JSON.stringify(request)})`;
}
