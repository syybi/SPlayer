<template>
  <div class="exclude">
    <n-alert :show-icon="false">请勿添加过多，以免影响歌词的正常显示</n-alert>

    <n-tabs type="line" v-model:value="page" animated>
      <n-tab-pane name="keywords" tab="关键词">
        <n-dynamic-tags v-model:value="settingStore.excludeKeywords" />
      </n-tab-pane>
      <n-tab-pane name="regexes" tab="正则表达式">
        <n-dynamic-tags v-model:value="settingStore.excludeRegexes" />
      </n-tab-pane>

      <template #suffix>
        <n-flex>
          <n-button type="primary" strong secondary @click="clear">清空此页</n-button>
          <n-button type="primary" strong secondary @click="reset">重置此页</n-button>
        </n-flex>
      </template>
    </n-tabs>
  </div>
</template>

<script setup lang="ts">
import { useSettingStore } from "@/stores";
import { keywords, regexes } from "@/assets/data/exclude";

const settingStore = useSettingStore();

const page = ref("keywords");

const pageConfig = {
  keywords: {
    name: "关键词",
    storeKey: "excludeKeywords",
    defaultValue: keywords,
  },
  regexes: {
    name: "正则表达式",
    storeKey: "excludeRegexes",
    defaultValue: regexes,
  },
} as const;

const handleAction = (action: "clear" | "reset") => {
  const pageKey = page.value as keyof typeof pageConfig;
  const { name, storeKey, defaultValue } = pageConfig[pageKey];
  const isClear = action === "clear";

  const actionText = isClear ? "清空" : "重置";
  const contentDetail = isClear ? "" : "为默认值";
  const successMessage = isClear ? "列表已清空" : "列表已重置为默认值";

  window.$dialog.warning({
    title: `${actionText}确认`,
    content: `确认${actionText}${name}列表${contentDetail}？该操作不可撤销！`,
    positiveText: "确认",
    negativeText: "取消",
    onPositiveClick: () => {
      settingStore[storeKey] = isClear ? [] : defaultValue;
      window.$message.success(`${name}${successMessage}`);
    },
  });
};

const clear = () => handleAction("clear");
const reset = () => handleAction("reset");
</script>

<style lang="scss" scoped>
.exclude {
  .n-alert {
    margin-bottom: 20px;
  }
}
</style>
