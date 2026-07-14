import type { AttachmentBuilder, EmbedBuilder } from 'discord.js';
import { buildShareEmbedActionRows } from './share-embed-actions';

export type ShareEmbedChannelPayload = {
  embeds: EmbedBuilder[]
  files?: AttachmentBuilder[]
  components?: ReturnType<typeof buildShareEmbedActionRows>
};

export async function resolveShareEmbedChannelPayload(params: {
  userId: string
  embed: EmbedBuilder
  files?: AttachmentBuilder[]
  shareRunRef?: string | null
  collapsed?: boolean
}): Promise<ShareEmbedChannelPayload> {
  void params.userId;
  return {
    embeds: [params.embed],
    files: params.files,
    components: buildShareEmbedActionRows({
      shareRunRef: params.shareRunRef,
      collapsed: params.collapsed === true,
    }),
  };
}
