const Anthropic = require("@anthropic-ai/sdk");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";
const MAX_TOKENS = Math.max(128, Number(process.env.ANTHROPIC_MAX_TOKENS) || 650);

const TOOLS = [
  {
    name: "create_budget",
    description:
      "Crea un presupuesto orientativo formal en el chat. Solo se usa cuando el cliente está cualificado (zona dentro de cobertura, alcance claro, muestra intención de avanzar, ha confirmado que es propietario o tiene permiso del dueño, el importe calculado es de al menos 600 €) y ya ha facilitado email. El sistema enviará un enlace de confirmación al email antes de mostrar el presupuesto.",
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
  {
    name: "notify_human",
    description:
      "Envía un aviso por email a Renoveplac (contacto@renoveplac.com) para que un humano (Luis) tome el caso. No tiene efecto visible en el chat para el cliente. Úsala cuando: el cliente tiene una queja/reclamación, pide hablar con una persona, es un lead premium (administrador de fincas, presidente, arquitecto, aparejador), la obra es de alto ticket (>15.000 €), o está fuera de zona pero con obra grande.",
    input_schema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          enum: [
            "queja",
            "solicita_humano",
            "lead_premium",
            "alto_ticket",
            "fuera_de_zona_obra_grande",
          ],
          description: "Motivo del aviso.",
        },
        summary: {
          type: "string",
          description:
            "Resumen breve para el equipo: alcance, zona, datos de contacto si los hay, urgencia y cualquier detalle relevante. Lo verán por email.",
        },
      },
      required: ["reason", "summary"],
    },
  },
];

async function runConversation({ systemPrompt, messages, onBudget, onNotifyHuman, maxTokens }) {
  const working = messages.map((m) => ({ role: m.role, content: m.content }));
  let finalText = "";
  let createdBudget = null;
  let safety = 0;
  const outputTokens = Math.max(128, Number(maxTokens) || MAX_TOKENS);

  while (safety < 3) {
    safety += 1;
    const startedAt = Date.now();
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: outputTokens,
      system: systemPrompt,
      tools: TOOLS,
      messages: working,
    });
    console.log(`[anthropic] respuesta en ${Date.now() - startedAt}ms (${MODEL})`);

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
            content: `Presupuesto guardado correctamente (id ${budget.id}). El cliente recibirá un enlace por email para confirmar antes de verlo en el chat.`,
          });
        } catch (err) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: `Error guardando presupuesto: ${err.message}`,
            is_error: true,
          });
        }
      } else if (tu.name === "notify_human" && typeof onNotifyHuman === "function") {
        try {
          await onNotifyHuman(tu.input);
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content:
              "Aviso enviado al equipo de Renoveplac por email. El cliente NO ha sido notificado por la tool: díselo tú con naturalidad en tu siguiente mensaje.",
          });
        } catch (err) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: `Error enviando aviso al equipo: ${err.message}`,
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
