import OpenAI from "openai";
import type { ChatCompletion, ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { config } from "./config.js";
import { sleep } from "./utils.js";

export const tools = [
  {
    type: "function",
    function: {
      name: "click",
      description: "Click a visible UI element using normalized screenshot coordinates.",
      parameters: {
        type: "object",
        properties: {
          element: { type: "string", description: "Precise description of the target element" },
          x: { type: "integer", minimum: 0, maximum: 1000 },
          y: { type: "integer", minimum: 0, maximum: 1000 },
        },
        required: ["element", "x", "y"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "click_text",
      description: "Click an element by its exact or near-exact visible text. Prefer this when the label is clear.",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "scroll",
      description: "Scroll the current page or modal.",
      parameters: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["up", "down"] },
          amount: { type: "integer", minimum: 200, maximum: 1200 },
        },
        required: ["direction", "amount"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_visible_images",
      description: "Download all sufficiently large images currently visible in the page, modal, viewer or gallery. Duplicate files are ignored automatically.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "press_key",
      description: "Press a navigation key, useful for closing a viewer or moving through a gallery.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", enum: ["Escape", "Enter", "ArrowLeft", "ArrowRight", "Home", "End"] },
        },
        required: ["key"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "go_back",
      description: "Go back one browser-history entry.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "wait",
      description: "Wait briefly for a page, image or modal to load.",
      parameters: {
        type: "object",
        properties: { seconds: { type: "integer", minimum: 1, maximum: 10 } },
        required: ["seconds"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finish",
      description: "Finish only when the requested updates have been processed, or when manual login/intervention is required.",
      parameters: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
        additionalProperties: false,
      },
    },
  },
] as const;

export class HoloClient {
  private readonly client: OpenAI;
  private previousCallAt = 0;

  constructor() {
    if (!config.apiKey) {
      throw new Error(
        "HAI_API_KEY is not set. Copy .env.example to .env and fill it in " +
          "(or set AI_MODE=none to disable the AI agent entirely).",
      );
    }
    this.client = new OpenAI({
      baseURL: "https://api.hcompany.ai/v1/",
      apiKey: config.apiKey,
    });
  }

  async next(messages: ChatCompletionMessageParam[]): Promise<ChatCompletion> {
    const elapsed = Date.now() - this.previousCallAt;
    if (elapsed < config.minApiIntervalMs) await sleep(config.minApiIntervalMs - elapsed);
    this.previousCallAt = Date.now();

    return this.client.chat.completions.create({
      model: config.model,
      messages,
      tools: tools as any,
      tool_choice: "required",
      temperature: 0.6,
      ...({ chat_template_kwargs: { enable_thinking: true } } as any),
    } as any);
  }
}
