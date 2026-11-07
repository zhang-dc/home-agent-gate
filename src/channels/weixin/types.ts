/**
 * Weixin ilink bot API wire types (JSON over HTTP; bytes fields are base64
 * strings). Mirrors the official @tencent-weixin/openclaw-weixin protocol.
 */

export interface BaseInfo {
  channel_version?: string;
  bot_agent?: string;
}

export const MessageType = { NONE: 0, USER: 1, BOT: 2 } as const;

export const MessageItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
  TOOL_CALL_START: 11,
  TOOL_CALL_RESULT: 12,
} as const;

export const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 } as const;

export interface TextItem {
  text?: string;
}

/** CDN media reference; aes_key is base64-encoded bytes in JSON. */
export interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  /** 加密类型: 0=只加密fileid, 1=打包缩略图/中图等信息 */
  encrypt_type?: number;
  /** 完整下载 URL（服务端直接返回，无需客户端拼接） */
  full_url?: string;
}

export interface ImageItem {
  media?: CDNMedia;
  thumb_media?: CDNMedia;
  /** Raw AES-128 key as hex string (16 bytes); preferred over media.aes_key for inbound decryption. */
  aeskey?: string;
  mid_size?: number;
}

export interface VoiceItem {
  /** 语音转文字内容（服务端转写） */
  text?: string;
  playtime?: number;
}

export interface RefMessage {
  message_item?: MessageItem;
  title?: string;
}

export interface MessageItem {
  type?: number;
  create_time_ms?: number;
  is_completed?: boolean;
  msg_id?: string;
  ref_msg?: RefMessage;
  text_item?: TextItem;
  voice_item?: VoiceItem;
  image_item?: ImageItem;
  // file/video items exist on the wire but are not yet consumed.
  [key: string]: unknown;
}

export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
  run_id?: string;
}

export interface GetUpdatesResp {
  ret?: number;
  /** e.g. -14 = bot session expired */
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface SendMessageReq {
  msg?: WeixinMessage;
}

export interface GetConfigResp {
  ret?: number;
  errmsg?: string;
  typing_ticket?: string;
}

export const TypingStatus = { TYPING: 1, CANCEL: 2 } as const;

export const SESSION_EXPIRED_ERRCODE = -14;
