import config from '../config/config.js';
import tokenManager from '../auth/token_manager.js';
import { generateRequestId } from './idGenerator.js';
import os from 'os';

// 全局思维签名缓存：用于记录 Gemini 返回的 thoughtSignature（工具调用与文本），
// 并在后续请求中复用，避免后端报缺失错误。
const thoughtSignatureMap = new Map();
const textThoughtSignatureMap = new Map();

function registerThoughtSignature(id, thoughtSignature) {
  if (!id || !thoughtSignature) return;
  thoughtSignatureMap.set(id, thoughtSignature);
}

function getThoughtSignature(id) {
  if (!id) return undefined;
  return thoughtSignatureMap.get(id);
}

function normalizeTextForSignature(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/!\[[^\]]*]\([^)]+\)/g, '')
    .replace(/\r\n/g, '\n')
    .trim();
}

function registerTextThoughtSignature(text, thoughtSignature) {
  if (!text || !thoughtSignature) return;
  const originalText = typeof text === 'string' ? text : String(text);
  const trimmed = originalText.trim();
  const normalized = normalizeTextForSignature(trimmed);
  const payload = { signature: thoughtSignature, text: originalText };
  if (originalText) {
    textThoughtSignatureMap.set(originalText, payload);
  }
  if (normalized) {
    textThoughtSignatureMap.set(normalized, payload);
  }
  if (trimmed && trimmed !== normalized) {
    textThoughtSignatureMap.set(trimmed, payload);
  }
}

function getTextThoughtSignature(text) {
  if (typeof text !== 'string' || !text.trim()) return undefined;
  if (textThoughtSignatureMap.has(text)) {
    return textThoughtSignatureMap.get(text);
  }
  const trimmed = text.trim();
  if (textThoughtSignatureMap.has(trimmed)) {
    return textThoughtSignatureMap.get(trimmed);
  }
  const normalized = normalizeTextForSignature(trimmed);
  if (!normalized) return undefined;
  return textThoughtSignatureMap.get(normalized);
}

function extractImagesFromContent(content) {
  const result = { text: '', images: [] };

  // 如果content是字符串，直接返回
  if (typeof content === 'string') {
    result.text = content;
    return result;
  }

  // 如果content是数组（multimodal格式）
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === 'text') {
        result.text += item.text;
      } else if (item.type === 'image_url') {
        // 提取base64图片数据
        const imageUrl = item.image_url?.url || '';

        // 匹配 data:image/{format};base64,{data} 格式
        const match = imageUrl.match(/^data:image\/(\w+);base64,(.+)$/);
        if (match) {
          const format = match[1]; // 例如 png, jpeg, jpg
          const base64Data = match[2];
          result.images.push({
            inlineData: {
              mimeType: `image/${format}`,
              data: base64Data
            }
          })
        }
      }
    }
  }

  return result;
}
function handleUserMessage(extracted, antigravityMessages) {
  antigravityMessages.push({
    role: "user",
    parts: [
      {
        text: extracted.text
      },
      ...extracted.images
    ]
  })
}
function handleToolCall(message, antigravityMessages) {
  // 从之前的 model 消息中找到对应的 functionCall name
  let functionName = '';
  for (let i = antigravityMessages.length - 1; i >= 0; i--) {
    if (antigravityMessages[i].role === 'model') {
      const parts = antigravityMessages[i].parts;
      for (const part of parts) {
        if (part.functionCall && part.functionCall.id === message.tool_call_id) {
          functionName = part.functionCall.name;
          break;
        }
      }
      if (functionName) break;
    }
  }

  // 处理 content 可能是字符串或对象的情况
  let output = message.content;
  if (typeof output === 'object' && output !== null) {
    // 如果是对象，尝试提取文本内容
    output = output.text || JSON.stringify(output);
  } else if (Array.isArray(output)) {
    // 如果是数组，提取第一个文本元素
    const textItem = output.find(item => item?.type === 'text' || typeof item === 'string');
    output = textItem?.text || textItem || JSON.stringify(output);
  }

  const lastMessage = antigravityMessages[antigravityMessages.length - 1];
  const functionResponse = {
    functionResponse: {
      id: message.tool_call_id,
      name: functionName,
      response: {
        output: output
      }
    }
  };

  // 如果上一条消息是 user 且包含 functionResponse，则合并
  if (lastMessage?.role === "user" && lastMessage.parts.some(p => p.functionResponse)) {
    lastMessage.parts.push(functionResponse);
  } else {
    antigravityMessages.push({
      role: "user",
      parts: [functionResponse]
    });
  }
}
function openaiMessageToAntigravity(openaiMessages, modelName) {
  const antigravityMessages = [];
  for (const message of openaiMessages) {
    // 修改点：只处理 user, assistant 和 tool，跳过 system
    if (message.role === "user") { 
      const extracted = extractImagesFromContent(message.content);
      handleUserMessage(extracted, antigravityMessages);
    } else if (message.role === "assistant") {
      handleAssistantMessage(message, antigravityMessages, modelName);
    } else if (message.role === "tool") {
      handleToolCall(message, antigravityMessages);
    }
  } 

  return antigravityMessages;
}
function generateGenerationConfig(parameters, enableThinking, actualModelName) {
  const generationConfig = {
    topP: parameters.top_p ?? config.defaults.top_p,
    topK: parameters.top_k ?? config.defaults.top_k,
    temperature: parameters.temperature ?? config.defaults.temperature,
    candidateCount: 1,
    maxOutputTokens: parameters.max_tokens ?? config.defaults.max_tokens,
    stopSequences: [
      "<|user|>",
      "<|bot|>",
      "<|context_request|>",
      "<|endoftext|>",
      "<|end_of_turn|>"
    ],
    thinkingConfig: {
      includeThoughts: enableThinking,
      thinkingBudget: enableThinking ? 1024 : 0
    }
  }
  if (enableThinking && actualModelName.includes("claude")) {
    delete generationConfig.topP;
  }
  return generationConfig
}
function convertOpenAIToolsToAntigravity(openaiTools) {
  if (!openaiTools || openaiTools.length === 0) return [];

  return openaiTools.map((tool) => {
    // 复制一份参数对象，避免修改原始数据
    const parameters = tool.function?.parameters ? { ...tool.function.parameters } : {};

    // 清理 JSON Schema，移除 Gemini 不支持的字段
    const cleanedParameters = cleanJsonSchema(parameters);

    // 确保 name 和 description 有效
    // 注意：不对 name 进行清理，保持原始名称以确保响应匹配
    const name = tool.function?.name || 'unknown_function';
    const description = tool.function?.description || '';

    return {
      functionDeclarations: [
        {
          name: name,  // 保持原始名称，不进行清理
          description: description,
          parameters: cleanedParameters
        }
      ]
    };
  });
}

/**
 * 清理函数名称，确保符合 Gemini API 要求
 * - 只允许字母、数字、下划线
 * - 不能以数字开头
 */
function sanitizeFunctionName(name) {
  if (!name || typeof name !== 'string') return 'unknown_function';
  // 替换非法字符为下划线
  let sanitized = name.replace(/[^a-zA-Z0-9_]/g, '_');
  // 如果以数字开头，添加前缀
  if (/^[0-9]/.test(sanitized)) {
    sanitized = 'fn_' + sanitized;
  }
  return sanitized || 'unknown_function';
}

/**
 * 清理 JSON Schema，使其兼容 Gemini API
 * 
 * 处理的问题类型：
 * 1. enum 包含空字符串/null/undefined
 * 2. anyOf/oneOf/allOf 联合类型
 * 3. const 字段转换
 * 4. $ref 引用（移除）
 * 5. 不支持的字段（移除）
 * 6. 类型不匹配问题
 * 7. required 包含不存在的属性
 * 8. 空对象/空数组处理
 * 9. 循环引用检测
 */
function cleanJsonSchema(schema, visited = new WeakSet()) {
  // 基础类型检查
  if (!schema || typeof schema !== 'object') {
    return schema;
  }

  // 循环引用检测
  if (visited.has(schema)) {
    return { type: 'object', description: '[Circular Reference]' };
  }
  visited.add(schema);

  // Gemini 支持的 JSON Schema 核心字段白名单
  const SUPPORTED_KEYS = new Set([
    'type',
    'properties',
    'items',
    'required',
    'description',
    'enum',
    'nullable',
    'format',      // 部分支持
    'minimum',     // 数值约束
    'maximum',
    'minItems',    // 数组约束
    'maxItems',
  ]);

  // Gemini 支持的类型
  const VALID_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);

  const cleanObject = (obj) => {
    if (obj === null || obj === undefined) {
      return null;
    }

    // 循环引用检测（递归调用时也检查）
    if (typeof obj === 'object' && visited.has(obj)) {
      return { type: 'object', description: '[Circular Reference]' };
    }
    if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
      visited.add(obj);
    }

    // 处理数组
    if (Array.isArray(obj)) {
      return obj
        .map(item => (typeof item === 'object' && item !== null ? cleanObject(item) : item))
        .filter(item => item !== null && item !== undefined);
    }

    if (typeof obj !== 'object') {
      return obj;
    }

    const cleaned = {};

    // ========== 1. 处理 $ref 引用 ==========
    // Gemini 不支持 $ref，直接跳过或返回通用类型
    if (obj.$ref) {
      return { type: 'object', description: `Reference: ${obj.$ref}` };
    }

    // ========== 2. 处理联合类型 (anyOf/oneOf/allOf) ==========
    const unionKey = ['anyOf', 'oneOf', 'allOf'].find(key => obj[key] && Array.isArray(obj[key]));
    if (unionKey) {
      const options = obj[unionKey].filter(opt => opt && typeof opt === 'object');
      
      if (options.length === 0) {
        return { type: 'string', description: obj.description || '' };
      }

      const mergedProperties = {};
      const mergedRequired = new Set();
      const mergedEnum = new Set();
      const mergedTypes = new Set();
      let hasProps = false;

      for (const option of options) {
        const cleanedOption = cleanObject(option);
        if (!cleanedOption) continue;

        // 收集类型
        if (cleanedOption.type) {
          mergedTypes.add(cleanedOption.type);
        }

        // 合并 properties
        if (cleanedOption.properties && typeof cleanedOption.properties === 'object') {
          Object.assign(mergedProperties, cleanedOption.properties);
          hasProps = true;
        }

        // 合并 required（仅 allOf 时保留）
        if (unionKey === 'allOf' && Array.isArray(cleanedOption.required)) {
          cleanedOption.required.forEach(r => mergedRequired.add(r));
        }

        // 合并 enum
        if (Array.isArray(cleanedOption.enum)) {
          cleanedOption.enum.forEach(v => {
            if (isValidEnumValue(v)) mergedEnum.add(v);
          });
        }
      }

      // 构建合并后的对象
      if (hasProps) {
        cleaned.type = 'object';
        cleaned.properties = mergedProperties;
        
        // 验证 required 字段
        if (mergedRequired.size > 0) {
          const validRequired = Array.from(mergedRequired).filter(r => 
            mergedProperties.hasOwnProperty(r)
          );
          if (validRequired.length > 0) {
            cleaned.required = validRequired;
          }
        }
      } else if (mergedEnum.size > 0) {
        cleaned.type = 'string';
        cleaned.enum = Array.from(mergedEnum);
      } else if (mergedTypes.size === 1) {
        // 只有一种类型
        cleaned.type = Array.from(mergedTypes)[0];
      } else if (mergedTypes.size > 1) {
        // 多种类型，Gemini 不支持，选择最通用的
        if (mergedTypes.has('string')) cleaned.type = 'string';
        else if (mergedTypes.has('object')) cleaned.type = 'object';
        else cleaned.type = Array.from(mergedTypes)[0];
      } else {
        // 回退到第一个选项
        return cleanObject(options[0]);
      }

      if (obj.description) cleaned.description = String(obj.description);
      return cleaned;
    }

    // ========== 3. 处理 const -> enum ==========
    if (obj.const !== undefined) {
      if (!isValidEnumValue(obj.const)) {
        cleaned.type = inferType(obj.const);
        if (obj.description) cleaned.description = String(obj.description);
        return cleaned;
      }
      cleaned.type = inferType(obj.const);
      cleaned.enum = [obj.const];
      if (obj.description) cleaned.description = String(obj.description);
      return cleaned;
    }

    // ========== 4. 处理 type 字段 ==========
    if (obj.type) {
      if (Array.isArray(obj.type)) {
        // 类型数组，如 ["string", "null"]
        const validTypes = obj.type.filter(t => VALID_TYPES.has(t));
        if (validTypes.length === 0) {
          cleaned.type = 'string';
        } else if (validTypes.includes('null')) {
          // 处理 nullable
          cleaned.type = validTypes.find(t => t !== 'null') || 'string';
          cleaned.nullable = true;
        } else {
          cleaned.type = validTypes[0];
        }
      } else if (VALID_TYPES.has(obj.type)) {
        cleaned.type = obj.type;
      } else {
        // 未知类型，映射到最接近的
        cleaned.type = mapUnknownType(obj.type);
      }
    }

    // ========== 5. 常规字段白名单过滤 ==========
    for (const [key, value] of Object.entries(obj)) {
      if (!SUPPORTED_KEYS.has(key) || key === 'type') continue;

      if (key === 'properties' && typeof value === 'object' && value !== null) {
        const cleanProps = {};
        for (const [pKey, pValue] of Object.entries(value)) {
          if (pKey && typeof pKey === 'string') {
            const cleanedProp = cleanObject(pValue);
            if (cleanedProp) {
              cleanProps[pKey] = cleanedProp;
            }
          }
        }
        if (Object.keys(cleanProps).length > 0) {
          cleaned.properties = cleanProps;
        }
      } else if (key === 'items' && typeof value === 'object') {
        const cleanedItems = cleanObject(value);
        if (cleanedItems) {
          cleaned.items = cleanedItems;
        }
      } else if (key === 'enum' && Array.isArray(value)) {
        const filteredEnum = value.filter(isValidEnumValue);
        if (filteredEnum.length > 0) {
          cleaned.enum = filteredEnum;
        }
      } else if (key === 'required' && Array.isArray(value)) {
        // 稍后验证
        cleaned._pendingRequired = value.filter(r => typeof r === 'string' && r.trim() !== '');
      } else if (key === 'description') {
        if (value && typeof value === 'string') {
          cleaned.description = value;
        } else if (value) {
          cleaned.description = String(value);
        }
      } else if (key === 'nullable') {
        cleaned.nullable = Boolean(value);
      } else if (['minimum', 'maximum', 'minItems', 'maxItems'].includes(key)) {
        if (typeof value === 'number' && !Number.isNaN(value)) {
          cleaned[key] = value;
        }
      } else if (key === 'format' && typeof value === 'string') {
        // 只保留常用格式
        const supportedFormats = ['date-time', 'date', 'time', 'email', 'uri', 'uuid'];
        if (supportedFormats.includes(value)) {
          cleaned.format = value;
        }
      }
    }

    // ========== 6. 验证 required 字段 ==========
    if (cleaned._pendingRequired && cleaned.properties) {
      const validRequired = cleaned._pendingRequired.filter(r => 
        cleaned.properties.hasOwnProperty(r)
      );
      if (validRequired.length > 0) {
        cleaned.required = validRequired;
      }
    }
    delete cleaned._pendingRequired;

    // ========== 7. 类型推断兜底 ==========
    if (!cleaned.type) {
      if (cleaned.properties) cleaned.type = 'object';
      else if (cleaned.items) cleaned.type = 'array';
      else if (cleaned.enum) cleaned.type = inferType(cleaned.enum[0]);
      else cleaned.type = 'string';
    }

    // ========== 8. 类型一致性验证 ==========
    if (cleaned.type === 'array' && !cleaned.items) {
      cleaned.items = { type: 'string' };
    }

    if (cleaned.type === 'object' && !cleaned.properties) {
      // 空对象类型，添加空 properties
      cleaned.properties = {};
    }

    return cleaned;
  };

  return cleanObject(schema);
}

/**
 * 检查枚举值是否有效
 */
function isValidEnumValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string' && value.trim() === '') return false;
  return true;
}

/**
 * 推断值的类型
 */
function inferType(value) {
  if (value === null) return 'string';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'number';
  }
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  return 'string';
}

/**
 * 映射未知类型到 Gemini 支持的类型
 */
function mapUnknownType(type) {
  const typeMap = {
    'int': 'integer',
    'float': 'number',
    'double': 'number',
    'bool': 'boolean',
    'str': 'string',
    'list': 'array',
    'dict': 'object',
    'map': 'object',
    'any': 'string',
    'null': 'string',
  };
  return typeMap[type?.toLowerCase()] || 'string';
}

/**
 * 生成发送给 Google Antigravity API 的请求体
 * 修复了系统指令合并逻辑，确保 VS Code Copilot 的行为定义不丢失
 */
function generateRequestBody(openaiMessages, modelName, parameters, openaiTools, token) {
  const actualModelName = modelName;

  // 1. 提取并合并系统指令
  // VS Code 会在 system 消息中定义智能体的行为，必须优先提取
  const systemContent = openaiMessages
    .filter(msg => msg.role === 'system')
    .map(msg => {
      if (typeof msg.content === 'string') return msg.content;
      if (Array.isArray(msg.content)) {
        return msg.content.map(c => c.text || '').join('');
      }
      return '';
    })
    .filter(Boolean)
    .join('\n\n');

  // 将配置文件中的默认指令与请求中的系统指令合并
  const finalSystemInstruction = [config.systemInstruction, systemContent]
    .filter(Boolean)
    .join('\n\n');

  // 2. 过滤掉 system 消息，仅保留对话内容
  // 避免 system 消息被错误地转换成 user 消息导致角色重复报错
  const conversationMessages = openaiMessages.filter(msg => msg.role !== 'system');

  // 3. 检测对话中是否已经存在带有 tool_calls 的 assistant 消息
  const hasAssistantToolCalls =
    Array.isArray(conversationMessages) &&
    conversationMessages.some(
      (msg) =>
        msg &&
        msg.role === 'assistant' &&
        Array.isArray(msg.tool_calls) &&
        msg.tool_calls.length > 0
    );

  // 4. 思维链 (Thinking) 启用逻辑
  const baseEnableThinking =
    modelName.endsWith('-thinking') ||
    modelName === 'gemini-2.5-pro' ||
    modelName.startsWith('gemini-3-pro-') ||
    modelName === "rev19-uic3-1p" ||
    modelName === "gpt-oss-120b-medium";

  // 为避免 Anthropic thinking + tools 冲突，当使用 Claude 系列且已有工具调用时关闭 thinking
  const enableThinking =
    baseEnableThinking &&
    !(actualModelName.includes('claude') && hasAssistantToolCalls);

  // 5. 将 OpenAI 风格消息转换为 Gemini contents
  const contents = openaiMessageToAntigravity(conversationMessages, actualModelName);

  // 6. 对 Claude 系列模型剔除不支持的 thoughtSignature
  if (actualModelName.includes('claude')) {
    for (const msg of contents) {
      if (!msg?.parts) continue;
      for (const part of msg.parts) {
        if (part && Object.prototype.hasOwnProperty.call(part, 'thoughtSignature')) {
          delete part.thoughtSignature;
        }
      }
    }
  }

  // 7. 构造最终请求体
  return {
    project: token.projectId,
    requestId: generateRequestId(),
    request: {
      contents,
      systemInstruction: {
        role: "user", // 适配 Google 内部接口的 systemInstruction 格式
        parts: [{ text: finalSystemInstruction || "You are a helpful assistant." }]
      },
      tools: convertOpenAIToolsToAntigravity(openaiTools),
      toolConfig: {
        functionCallingConfig: {
          mode: "VALIDATED"
        }
      },
      generationConfig: generateGenerationConfig(parameters, enableThinking, actualModelName),
      sessionId: token.sessionId
    },
    model: actualModelName,
    userAgent: "antigravity"
  };
}
function getDefaultIp() {
  const interfaces = os.networkInterfaces();
  if (interfaces.WLAN) {
    for (const inter of interfaces.WLAN) {
      if (inter.family === 'IPv4' && !inter.internal) {
        return inter.address;
      }
    }
  } else if (interfaces.wlan2) {
    for (const inter of interfaces.wlan2) {
      if (inter.family === 'IPv4' && !inter.internal) {
        return inter.address;
      }
    }
  }
  return '127.0.0.1';
}

// 将 Gemini 原生 GenerateContentRequest 直接包装为 AntigravityRequester 所需的请求体
// 这样可以对外暴露 Gemini 规范，而内部仍复用同一套后端调用链
function generateRequestBodyFromGemini(geminiRequest, modelName, token) {
  const actualModelName = modelName;

  // 是否启用思维链，沿用现有逻辑，避免行为不一致
  const baseEnableThinking =
    actualModelName.endsWith('-thinking') ||
    actualModelName === 'gemini-2.5-pro' ||
    actualModelName.startsWith('gemini-3-pro-') ||
    actualModelName === 'rev19-uic3-1p' ||
    actualModelName === 'gpt-oss-120b-medium';
  const enableThinking = baseEnableThinking && !actualModelName.includes('claude');

  const contents = Array.isArray(geminiRequest?.contents) ? geminiRequest.contents : [];

  const systemInstruction =
    geminiRequest?.systemInstruction && typeof geminiRequest.systemInstruction === 'object'
      ? geminiRequest.systemInstruction
      : {
          role: 'user',
          parts: [{ text: config.systemInstruction }]
        };

  const request = {
    contents,
    systemInstruction,
    tools: Array.isArray(geminiRequest?.tools) ? geminiRequest.tools : undefined,
    toolConfig: geminiRequest?.toolConfig,
    safetySettings: geminiRequest?.safetySettings,
    generationConfig:
      geminiRequest?.generationConfig ||
      generateGenerationConfig({}, enableThinking, actualModelName),
    sessionId: token.sessionId
  };

  return {
    project: token.projectId,
    requestId: generateRequestId(),
    request,
    model: actualModelName,
    userAgent: 'antigravity'
  };
}

// 覆盖上方的 handleAssistantMessage 实现：
// 当找不到 Gemini 思维签名时，降级为普通文本发送，而不是直接丢弃该 assistant 文本，避免导致请求 400。
function handleAssistantMessage(message, antigravityMessages, modelName) {
  const lastMessage = antigravityMessages[antigravityMessages.length - 1];
  const hasToolCalls = message.tool_calls && message.tool_calls.length > 0;
  const allowThoughtSignature = typeof modelName === 'string' && modelName.includes('gemini-3');

  // 统一提取 assistant 的纯文本内容
  let contentText = '';
  if (message.content) {
    if (Array.isArray(message.content)) {
      contentText = message.content
        .filter(item => item.type === 'text')
        .map(item => item.text || '')
        .join('');
    } else if (typeof message.content === 'string') {
      contentText = message.content;
    }
  }
  const hasContent = contentText.trim() !== '';

  // 将 OpenAI 风格的 tool_calls 转成 Antigravity/Gemini 所需的 functionCall part
  const antigravityTools = hasToolCalls ? message.tool_calls.map(toolCall => {
    let args = {};
    try {
      if (typeof toolCall.function.arguments === 'string') {
        args = JSON.parse(toolCall.function.arguments);
      } else if (typeof toolCall.function.arguments === 'object') {
        args = toolCall.function.arguments;
      }
    } catch (e) {
      console.warn('Failed to parse tool call arguments:', e);
    }

    const thoughtSignature = getThoughtSignature(toolCall.id);
    const part = {
      functionCall: {
        id: toolCall.id,
        name: toolCall.function.name,
        args: args
      }
    };

    if (thoughtSignature) {
      part.thoughtSignature = thoughtSignature;
    }

    return part;
  }) : [];

  // 如果只是补齐工具调用结果且没有新文本，直接合并到上一条 model 消息里
  if (lastMessage?.role === 'model' && hasToolCalls && !hasContent) {
    lastMessage.parts.push(...antigravityTools);
    return;
  }

  const parts = [];

  // 这里是关键改动：
  // 1. 优先尝试从缓存中找到与文本匹配的思维签名
  // 2. 找不到时，仍然发送纯文本（只是不带 thoughtSignature），避免直接丢弃 assistant 文本
  if (hasContent) {
    const textThoughtSignature = allowThoughtSignature ? getTextThoughtSignature(contentText) : undefined;
    const textPart = { text: textThoughtSignature?.text ?? contentText };

    if (allowThoughtSignature && textThoughtSignature?.signature) {
      textPart.thoughtSignature = textThoughtSignature.signature;
    }

    parts.push(textPart);
  }

  parts.push(...antigravityTools);

  antigravityMessages.push({
    role: 'model',
    parts
  });
}
export {
  generateRequestId,
  generateRequestBody,
  generateRequestBodyFromGemini,
  getDefaultIp,
  cleanJsonSchema,
  registerThoughtSignature,
  registerTextThoughtSignature,
  getTextThoughtSignature,
  getThoughtSignature
}
