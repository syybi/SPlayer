<template>
  <div class="sidebar-hide-manager">
    <n-scrollbar style="max-height: 400px" trigger="none">
      <div class="list">
        <n-card
          v-for="item in sidebarItems"
          :key="item.key"
          :content-style="{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            padding: '16px',
          }"
          class="item"
        >
          <n-text class="name">{{ item.label }}</n-text>
          <n-switch
            :value="settingStore[item.key]"
            :round="false"
            @update:value="(val) => updateSetting(item.key, val)"
          />
        </n-card>
      </div>
    </n-scrollbar>
  </div>
</template>

<script setup lang="ts">
import { NScrollbar } from "naive-ui";
import { useSettingStore } from "@/stores";

const settingStore = useSettingStore();

const sidebarItems = [
  { label: "发现音乐", key: "hideDiscover" },
  { label: "私人漫游", key: "hidePersonalFM" },
  { label: "播客电台", key: "hideRadioHot" },
  { label: "我的收藏", key: "hideLike" },
  { label: "我的云盘", key: "hideCloud" },
  { label: "下载管理", key: "hideDownload" },
  { label: "本地歌曲", key: "hideLocal" },
  { label: "最近播放", key: "hideHistory" },
  { label: "创建的歌单", key: "hideUserPlaylists" },
  { label: "收藏的歌单", key: "hideLikedPlaylists" },
  { label: "心动模式", key: "hideHeartbeatMode" },
] as const;

const updateSetting = (key: keyof typeof settingStore, val: boolean) => {
  // @ts-ignore
  settingStore[key] = val;
};
</script>

<style scoped lang="scss">
.list {
  margin-top: 12px;
  padding-right: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  .item {
    border-radius: 8px;
    .name {
      font-size: 16px;
      line-height: normal;
    }
    .n-switch {
      margin-left: auto;
    }
  }
}
</style>
