const Anthropic = require("@anthropic-ai/sdk");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";

const TOOLS = [
  {
    name: "create_budget",
    description:
      "Crea un presupuesto orientativo formal en el chat. Solo se usa cuando el cliente está cualificado (zona dentro de cobertura, alcance claro y muestra intención de avanzar). El presupuesto se mostrará en la conversación con un botón para que el cliente lo acepte y se inicie el contacto comercial.",
    input_schema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Título corto del presupuesto. Ej: 'Reforma baño completo en L'Eliana'.",
        },
        description: {
          type: "string",
          description:
            "Descripción del alcance: partidas que incluye, materiales si aplica, plazo aproximado y aclaración de que es orientativo previo a visita técnica.",
        },
        amount_eur: {
          type: "number",
          description: "Importe orientativo en euros (número, sin símbolo).",
        },
        iva_included: {
          type: "boolean",
          description: "true si el importe ya incluye IVA, false si va aparte (lo habitual).",
        },
      },
      required: ["title", "description", "amount_eur", "iva_included"],
    },
  },
];

async function runConversation({ systemPrompt, messages, onBudget }) {
  const working = messages.map((m) => ({ role: m.role, content: m.content }));
  let finalText = "";
  let createdBudget = null;
  let safety = 0;

  while (safety < 3) {
    safety += 1;
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      tools: TOOLS,
      messages: working,
    });

    const textBlocks = [];
    const toolUses = [];
    for (const block of response.content) {
      if (block.type === "text" && block.text) textBlocks.push(block.text);
      if (block.type === "tool_use") toolUses.push(block);
    }

    if (textBlocks.length) finalText = textBlocks.join("\n").trim();

    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      break;
    }

    working.push({ role: "assistant", content: response.content });

    const toolResults = [];
    for (const tu of toolUses) {
      if (tu.name === "create_budget" && typeof onBudget === "function") {
        try {
          const budget = await onBudget(tu.input);
          createdBudget = budget;
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: `Presupuesto guardado correctamente (id ${budget.id}). El cliente lo verá en el chat con un botón para aceptarlo.`,
          });
        } catch (err) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: `Error guardando presupuesto: ${err.message}`,
            is_error: true,
          });
        }
      } else {
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: "Tool desconocida.",
          is_error: true,
        });
      }
    }

    working.push({ role: "user", content: toolResults });
  }

  return { text: finalText, budget: createdBudget };
}

module.exports = { runConversation };
