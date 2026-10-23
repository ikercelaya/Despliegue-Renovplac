const Anthropic = require("@anthropic-ai/sdk");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";
const MAX_TOKENS = Math.max(128, Number(process.env.ANTHROPIC_MAX_TOKENS) || 650);

const TOOLS = [
  {
    name: "create_budget",
    description:
      "Crea un presupuesto orientativo formal en el chat. Solo se usa cuando el cliente esta cualificado (zona dentro de cobertura, alcance claro, muestra intencion de avanzar, ha confirmado que es propietario o tiene permiso del dueno, el importe calculado es de al menos 600 EUR) y ya ha facilitado nombre completo, telefono, email y codigo postal. Nunca escribas el presupuesto completo o un importe concreto en texto libre sin usar esta herramienta. El sistema enviara un enlace de confirmacion al email antes de mostrar el presupuesto.",
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
      "Envía un aviso por email a Renoveplac (contacto@renoveplac.com) para que un profesional del equipo tome el caso. No tiene efecto visible en el chat para el cliente. Úsala cuando: el cliente tiene una queja/reclamación, pide hablar con una persona, pide cita o quiere agendar una visita, es un lead premium (administrador de fincas, presidente, arquitecto, aparejador), la obra es de alto ticket (>15.000 €), o está fuera de zona pero con obra grande.",
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
  {
    name: "register_electric_request",
    description:
      "Registra una solicitud de un servicio de ELECTRICIDAD (boletin electrico/CIE, instalacion electrica completa de vivienda o local, cambio de cuadro y aumento de potencia, punto de recarga para coche electrico, placas solares en vivienda unifamiliar o averia electrica con cita) y avisa al equipo por email. Estos servicios NUNCA llevan importe ni create_budget. Usala solo cuando el cliente ya te haya dado en la conversacion: nombre, telefono, pueblo, direccion de la obra, que necesita y como nos ha conocido. No inventes ningun dato: si falta alguno, pidelo antes.",
    input_schema: {
      type: "object",
      properties: {
        service: {
          type: "string",
          enum: [
            "Boletín eléctrico",
            "Instalación eléctrica",
            "Cuadro eléctrico y potencia",
            "Punto de recarga",
            "Placas solares",
            "Avería eléctrica",
          ],
          description: "Servicio de electricidad que solicita el cliente.",
        },
        customer_name: { type: "string", description: "Nombre del cliente tal como lo ha dado." },
        phone: { type: "string", description: "Telefono del cliente (9 cifras o con +34)." },
        town: { type: "string", description: "Pueblo o municipio de la obra." },
        address: { type: "string", description: "Direccion de la obra (calle y numero o lo que haya indicado)." },
        need: {
          type: "string",
          description: "Que necesita el cliente, con los detalles que haya dado (cuadro, contador, zona del trabajo, fotos o video enviados...).",
        },
        lead_source: {
          type: "string",
          description: "Como nos ha conocido el cliente (Google, Instagram, recomendacion...).",
        },
      },
      required: ["service", "customer_name", "phone", "town", "address", "need", "lead_source"],
    },
  },
];

async function runConversation({ systemPrompt, messages, onBudget, onNotifyHuman, onElectricRequest, maxTokens, stopAfterBudget }) {
  const working = messages.map((m) => ({ role: m.role, content: m.content }));
  let finalText = "";
  let createdBudget = null;
  let electricRequest = null;
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
          if (stopAfterBudget) {
            return { text: finalText, budget: createdBudget, electricRequest };
          }
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
      } else if (tu.name === "register_electric_request" && typeof onElectricRequest === "function") {
        try {
          electricRequest = await onElectricRequest(tu.input);
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content:
              "Solicitud de electricidad registrada y equipo avisado por email. Cierra con: \"Un profesional de nuestro equipo revisa tu caso y te contactamos para preparar el presupuesto, sin compromiso.\"",
          });
        } catch (err) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: `No se ha registrado la solicitud: ${err.message}`,
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

  return { text: finalText, budget: createdBudget, electricRequest };
}

module.exports = { runConversation };
