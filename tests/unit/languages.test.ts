import { expect, test } from "bun:test";
import { runSchema, type Observation, type Target } from "../../src/contracts.ts";
import { assumeDeterministic, resolveFast } from "../../src/fastpath.ts";
import { searchPlan } from "../../src/search.ts";

const target = (ref: string, label: string, role: string, extra: Partial<Target> = {}): Target => ({
  ref,
  label,
  role,
  ...extra,
});
const page = (targets: Observation["targets"], controls?: string[]): Observation => ({
  url: "https://example.com",
  tree: "App",
  fingerprint: "one",
  elements: [],
  snapshotId: "snap",
  targets,
  ...(controls ? { controls } : {}),
});
const run = (steps: unknown[], languages?: string[]) =>
  runSchema.parse({
    prompt: "Test",
    steps,
    session: "fast",
    backend: { provider: "laya" },
    expect: [{ text: "App" }],
    ...(languages ? { languages } : {}),
  });
const decide = (observation: Observation, step: unknown, languages?: string[]) =>
  resolveFast(run([step], languages), 0, observation, []);

// Pedidos: three rows with Editar and Excluir, and two Pagar (a link in Cobrança, a button in Entrega).
const pedidos = page({
  CLICK: {
    e1: target("e1", "Editar", "button", { context: "Pedido 1001 Ada Editar Excluir | Pedidos" }),
    e2: target("e2", "Excluir", "button", { context: "Pedido 1001 Ada Editar Excluir | Pedidos" }),
    e3: target("e3", "Editar", "button", { context: "Pedido 1002 Grace Editar Excluir | Pedidos" }),
    e4: target("e4", "Excluir", "button", { context: "Pedido 1002 Grace Editar Excluir | Pedidos" }),
    e5: target("e5", "Pagar", "link", { context: "Cobranca" }),
    e6: target("e6", "Pagar", "button", { context: "Entrega" }),
  },
});
const clickedPt = (instruction: string) => decide(pedidos, instruction, ["pt"])?.targetId;

test("Portuguese click steps name a control by kind, place and position", () => {
  expect(clickedPt("Clique no botão Pagar")).toBe("e6");
  expect(clickedPt("Clique no link Pagar")).toBe("e5");
  expect(clickedPt("Clique em Pagar na seção Entrega")).toBe("e6");
  expect(clickedPt("Clique em Excluir na linha do Pedido 1002")).toBe("e4");
  expect(clickedPt("Clique no segundo botão Editar")).toBe("e3");
  expect(clickedPt("Clique no último Editar")).toBe("e3");
  expect(clickedPt("Clique em Excluir")).toBeUndefined();
  expect(clickedPt("Clique em Excluir na linha do Pedido 9999")).toBeUndefined();
});

test("Spanish click steps name a control by kind, place and position", () => {
  const pedidosEs = page({
    CLICK: {
      e1: target("e1", "Editar", "button", { context: "Pedido 1001 Ada Editar Eliminar | Pedidos" }),
      e3: target("e3", "Editar", "button", { context: "Pedido 1002 Grace Editar Eliminar | Pedidos" }),
      e5: target("e5", "Pagar", "link", { context: "Facturación" }),
      e6: target("e6", "Pagar", "button", { context: "Envío" }),
    },
  });
  const clickedEs = (instruction: string) => decide(pedidosEs, instruction, ["es"])?.targetId;
  expect(clickedEs("Haz clic en el botón Pagar")).toBe("e6");
  expect(clickedEs("Haz clic en el enlace Pagar")).toBe("e5");
  expect(clickedEs("Haz clic en Pagar en la sección Envío")).toBe("e6");
  expect(clickedEs("Haz clic en el segundo botón Editar")).toBe("e3");
  expect(clickedEs("Pulsa el último Editar")).toBe("e3");
  expect(clickedEs("Haz clic en Editar")).toBeUndefined();
});

test("Portuguese and Spanish typing and Enter steps find the field and the value", () => {
  const field = (label: string) => target("e3", label, "searchbox", { currentValue: "" });
  const pesquisa = page({ TYPE_TEXT: { e3: field("Pesquisar") }, PRESS_ENTER: { e3: field("Pesquisar") } });
  expect(decide(pesquisa, { instruction: "Digite IPv4 na caixa Pesquisar", value: "IPv4" }, ["pt"])).toMatchObject({
    operation: "TYPE_TEXT",
    targetId: "e3",
    rule: "type",
  });
  expect(decide(pesquisa, { instruction: "Preencha o campo Pesquisar com IPv4", value: "IPv4" }, ["pt"])).toMatchObject(
    { operation: "TYPE_TEXT", targetId: "e3" },
  );
  expect(decide(pesquisa, "Pressione Enter na caixa Pesquisar para buscar", ["pt"])).toMatchObject({
    operation: "PRESS_ENTER",
    targetId: "e3",
  });
  const buscar = page({ TYPE_TEXT: { e3: field("Buscar") }, PRESS_ENTER: { e3: field("Buscar") } });
  expect(decide(buscar, { instruction: "Escribe IPv4 en el cuadro Buscar", value: "IPv4" }, ["es"])).toMatchObject({
    operation: "TYPE_TEXT",
    targetId: "e3",
  });
  expect(decide(buscar, { instruction: "Rellena el campo Buscar con IPv4", value: "IPv4" }, ["es"])).toMatchObject({
    operation: "TYPE_TEXT",
    targetId: "e3",
  });
  expect(decide(buscar, "Pulsa Enter en el cuadro Buscar", ["es"])).toMatchObject({
    operation: "PRESS_ENTER",
    targetId: "e3",
  });
});

test("Portuguese and Spanish dropdown, switch and scroll steps", () => {
  const form = page(
    {
      SELECT: {
        "e1:1": target("e1:1", "País → Brasil", "combobox"),
        "e1:2": target("e1:2", "País → Chile", "combobox"),
      },
      CLICK: {
        e9: target("e9", "Notificações", "switch", { checked: "false" }),
        e8: target("e8", "Aceito os termos", "checkbox", { checked: "true" }),
        e7: target("e7", "Casilla Acepto los términos", "checkbox", { checked: "false" }),
      },
      SCROLL_DOWN: {
        page: target("page", "Page", "scrollable"),
        s1: target("s1", "Resultados", "scrollable", { currentValue: "0% scrolled" }),
      },
    },
    ["SCROLL_DOWN"],
  );
  expect(decide(form, "Selecione Brasil no campo País", ["pt"])).toMatchObject({
    operation: "SELECT",
    targetId: "e1:1",
  });
  expect(decide(form, "Selecciona Chile en el campo País", ["es"])).toMatchObject({
    operation: "SELECT",
    targetId: "e1:2",
  });
  expect(decide(form, "Ative as notificações", ["pt"])).toMatchObject({
    operation: "CLICK",
    targetId: "e9",
    rule: "toggle",
  });
  expect(decide(form, "Marque a caixa Aceito os termos", ["pt"])).toMatchObject({ operation: "DONE", rule: "toggle" });
  expect(decide(form, "Desmarque a caixa Aceito os termos", ["pt"])).toMatchObject({
    operation: "CLICK",
    targetId: "e8",
  });
  expect(decide(form, "Role para baixo", ["pt"])).toMatchObject({ operation: "SCROLL_DOWN", rule: "scroll" });
  expect(decide(form, "Role para baixo na lista Resultados", ["pt"])).toMatchObject({
    operation: "SCROLL_DOWN",
    targetId: "s1",
  });
  expect(decide(form, "Desplázate hacia abajo", ["es"])).toMatchObject({ operation: "SCROLL_DOWN", targetId: "page" });
});

test("a conditional or negated step in Portuguese or Spanish is left to the model", () => {
  expect(clickedPt("Se aparecer, clique em Pagar no botão")).toBeUndefined();
  expect(clickedPt("Clique no botão Pagar ou no link Pagar")).toBeUndefined();
  expect(decide(pedidos, "Si aparece, haz clic en Pagar", ["es"])).toBeNull();
  expect(decide(pedidos, "Haz clic en Editar o en Pagar", ["es"])).toBeNull();
});

test("a step is read in the languages of the test only, in the order listed", () => {
  // Without `languages`, the test is English: a Portuguese step goes to the model.
  expect(decide(pedidos, "Clique no botão Pagar")).toBeNull();
  expect(decide(pedidos, "Clique no botão Pagar", ["en"])).toBeNull();
  expect(decide(pedidos, "Clique no botão Pagar", ["es"])).toBeNull();
  // Each step is read in the language it is written in.
  const bilingual = page({ CLICK: { e1: target("e1", "Pagar", "button"), e2: target("e2", "Pay", "link") } });
  const mixed = run(["Clique no botão Pagar", "Click the Pay link"], ["pt", "en"]);
  expect(resolveFast(mixed, 0, bilingual, [])).toMatchObject({ targetId: "e1" });
  expect(resolveFast(mixed, 1, bilingual, [])).toMatchObject({ targetId: "e2" });
});

test("a Portuguese or Spanish field assumption is answered from the page", () => {
  const typed = page({ TYPE_TEXT: { e3: target("e3", "Pesquisar", "searchbox", { currentValue: "IPv4" }) } });
  expect(assumeDeterministic("A caixa Pesquisar contém IPv4", typed, ["pt"])).toBe(true);
  expect(assumeDeterministic("O campo Pesquisar tem Brasil", typed, ["pt"])).toBe(false);
  expect(assumeDeterministic("El campo Pesquisar contiene IPv4", typed, ["es"])).toBe(true);
  expect(assumeDeterministic("A caixa Pesquisar contém IPv4 ou Brasil", typed, ["pt"])).toBeUndefined();
  expect(assumeDeterministic("A caixa Pesquisar contém IPv4", typed)).toBeUndefined();
});

test("a Portuguese or Spanish switch or dropdown assumption is answered from the page", () => {
  const form: Observation = {
    ...page({
      CLICK: {
        e1: target("e1", "Aceito os termos", "checkbox", { checked: "true" }),
        e2: target("e2", "Notificaciones", "switch", { checked: "false" }),
      },
    }),
    elements: [{ index: "e5", label: "País", role: "combobox", value: "Brasil", operations: ["SELECT"] }],
  };
  expect(assumeDeterministic("A caixa Aceito os termos está marcada", form, ["pt"])).toBe(true);
  expect(assumeDeterministic("A caixa Aceito os termos está desmarcada", form, ["pt"])).toBe(false);
  expect(assumeDeterministic("El interruptor Notificaciones está activado", form, ["es"])).toBe(false);
  expect(assumeDeterministic("El interruptor Notificaciones está apagado", form, ["es"])).toBe(true);
  expect(assumeDeterministic("A lista País mostra Brasil", form, ["pt"])).toBe(true);
  expect(assumeDeterministic("A lista País mostra Chile", form, ["pt"])).toBe(false);
  expect(assumeDeterministic("La lista País muestra Brasil", form, ["es"])).toBe(true);
});

test("a search for a hidden control reads the click step in the test's languages", () => {
  expect(searchPlan({ instruction: "Clique em Pagar na seção Entrega" }, ["pt"])).toEqual({
    needle: "pagar",
    within: "entrega",
    exact: false,
  });
  expect(searchPlan({ instruction: "Clique em Pagar na seção Entrega" })).toBeNull();
});
