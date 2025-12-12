<!-- 本地设置 -->
<template>
  <div class="setting-type">
    <div class="set-list">
      <n-h3 prefix="bar"> 本地歌曲 </n-h3>
      <n-card class="set-item">
        <div class="label">
          <n-text class="name">显示本地歌曲封面</n-text>
          <n-text class="tip" :depth="3">当数量过多时请勿开启，会严重影响性能</n-text>
        </div>
        <n-switch class="set" v-model:value="settingStore.showLocalCover" :round="false" />
      </n-card>
      <n-card class="set-item">
        <div class="label">
          <n-text class="name">显示本地默认歌曲目录</n-text>
        </div>
        <n-switch class="set" v-model:value="settingStore.showDefaultLocalPath" :round="false" />
      </n-card>
      <n-card class="set-item" id="local-list-choose" content-style="flex-direction: column">
        <n-flex justify="space-between">
          <div class="label">
            <n-text class="name">本地歌曲目录</n-text>
            <n-text class="tip" :depth="3">可在此增删本地歌曲目录，歌曲增删实时同步</n-text>
          </div>
          <n-button strong secondary @click="changeLocalMusicPath()">
            <template #icon>
              <SvgIcon name="Folder" />
            </template>
            更改
          </n-button>
        </n-flex>
        <n-collapse-transition :show="settingStore.localFilesPath.length > 0">
          <n-card
            v-for="(item, index) in settingStore.localFilesPath"
            :key="index"
            class="set-item"
          >
            <div class="label">
              <n-text class="name">{{ item }}</n-text>
            </div>
            <n-button strong secondary @click="changeLocalMusicPath(index)">
              <template #icon>
                <SvgIcon name="Delete" />
              </template>
            </n-button>
          </n-card>
        </n-collapse-transition>
      </n-card>
      <n-card class="set-item" id="local-list-choose" content-style="flex-direction: column">
        <n-flex justify="space-between">
          <div class="label">
            <n-text class="name">本地歌词覆盖在线歌词</n-text>
            <n-text class="tip" :depth="3">
              可在这些文件夹及其子文件夹内覆盖在线歌曲的歌词 <br />
              将歌词文件命名为 `歌曲ID.后缀名` 或者 `任意前缀.歌曲ID.后缀名` 即可 <br />
              支持 .lrc 和 .ttml 格式 <br />
              （提示：可以在前缀加上歌名等信息，也可以利用子文件夹分类管理）
            </n-text>
          </div>
          <n-button strong secondary @click="changeLocalLyricPath()">
            <template #icon>
              <SvgIcon name="Folder" />
            </template>
            更改
          </n-button>
        </n-flex>
        <n-collapse-transition :show="settingStore.localLyricPath.length > 0">
          <n-card
            v-for="(item, index) in settingStore.localLyricPath"
            :key="index"
            class="set-item"
          >
            <div class="label">
              <n-text class="name">{{ item }}</n-text>
            </div>
            <n-button strong secondary @click="changeLocalLyricPath(index)">
              <template #icon>
                <SvgIcon name="Delete" />
              </template>
            </n-button>
          </n-card>
        </n-collapse-transition>
      </n-card>
    </div>
    <div class="set-list">
      <n-h3 prefix="bar"> 下载配置 </n-h3>
      <n-card class="set-item">
        <div class="label">
          <n-text class="name">默认下载目录</n-text>
          <n-text class="tip" :depth="3">
            {{ settingStore.downloadPath || "若不设置则无法进行下载" }}
          </n-text>
        </div>
        <n-flex>
          <Transition name="fade" mode="out-in">
            <n-button
              v-if="settingStore.downloadPath"
              type="primary"
              strong
              secondary
              @click="settingStore.downloadPath = ''"
            >
              清除选择
            </n-button>
          </Transition>
          <n-button strong secondary @click="choosePath">
            <template #icon>
              <SvgIcon name="Folder" />
            </template>
            更改
          </n-button>
        </n-flex>
      </n-card>
      <n-card class="set-item">
        <div class="label">
          <n-text class="name">默认下载音质</n-text>
          <n-text class="tip" :depth="3">
            默认使用的音质，实际可用音质取决于账号权限和歌曲资源
          </n-text>
        </div>
        <n-select
          v-model:value="settingStore.downloadSongLevel"
          :options="downloadQualityOptions"
          class="set"
        />
      </n-card>
      <n-card class="set-item">
        <div class="label">
          <n-text class="name">下载歌曲元信息</n-text>
          <n-text class="tip" :depth="3">为当前下载歌曲附加封面及歌词等元信息</n-text>
        </div>
        <n-switch class="set" v-model:value="settingStore.downloadMeta" :round="false" />
      </n-card>
      <n-card class="set-item">
        <div class="label">
          <n-text class="name">同时下载封面</n-text>
          <n-text class="tip" :depth="3">下载歌曲时同时下载封面</n-text>
        </div>
        <n-switch
          v-model:value="settingStore.downloadCover"
          :disabled="!settingStore.downloadMeta"
          :round="false"
          class="set"
        />
      </n-card>
      <n-card class="set-item">
        <div class="label">
          <n-text class="name">同时下载歌词</n-text>
          <n-text class="tip" :depth="3">下载歌曲时同时下载歌词</n-text>
        </div>
        <n-switch
          v-model:value="settingStore.downloadLyric"
          :disabled="!settingStore.downloadMeta"
          :round="false"
          class="set"
        />
      </n-card>
      <n-card class="set-item">
        <div class="label">
          <n-text class="name">同时下载歌词翻译</n-text>
          <n-text class="tip" :depth="3">下载歌词时同时包含翻译</n-text>
        </div>
        <n-switch
          v-model:value="settingStore.downloadLyricTranslation"
          :disabled="!settingStore.downloadMeta || !settingStore.downloadLyric"
          :round="false"
          class="set"
        />
      </n-card>
      <n-card class="set-item">
        <div class="label">
          <n-text class="name">同时下载歌词音译</n-text>
          <n-text class="tip" :depth="3">下载歌词时同时包含音译（罗马音）</n-text>
        </div>
        <n-switch
          v-model:value="settingStore.downloadLyricRomaji"
          :disabled="!settingStore.downloadMeta || !settingStore.downloadLyric"
          :round="false"
          class="set"
        />
      </n-card>
      <n-card class="set-item">
        <div class="label">
          <n-text class="name">音乐命名格式</n-text>
          <n-text class="tip" :depth="3">
            选择下载文件的命名方式，建议包含歌手信息便于区分
          </n-text>
        </div>
        <n-select
          v-model:value="settingStore.fileNameFormat"
          :options="fileNameFormatOptions"
          class="set"
        />
      </n-card>
      <n-card class="set-item">
        <div class="label">
          <n-text class="name">文件智能分类</n-text>
          <n-text class="tip" :depth="3">
            自动按歌手或歌手与专辑创建子文件夹进行分类
          </n-text>
        </div>
        <n-select
          v-model:value="settingStore.folderStrategy"
          :options="folderStrategyOptions"
          class="set"
        />
      </n-card>
      <n-card class="set-item">
        <div class="label">
          <n-text class="name">
            模拟播放下载
            <n-tag type="warning" size="small" round>Beta</n-tag>
          </n-text>
          <n-text class="tip" :depth="3">使用播放接口进行下载，可能解决部分下载失败问题</n-text>
        </div>
        <n-switch
          :value="settingStore.usePlaybackForDownload"
          :round="false"
          class="set"
          @update:value="handlePlaybackDownloadChange"
        />
      </n-card>
      <n-card class="set-item">
        <div class="label">
          <n-text class="name">保留元信息文件</n-text>
          <n-text class="tip" :depth="3">是否在下载目录中保留元信息文件</n-text>
        </div>
        <n-switch
          v-model:value="settingStore.saveMetaFile"
          :disabled="!settingStore.downloadMeta"
          :round="false"
          class="set"
        />
      </n-card>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useSettingStore } from "@/stores";
import { changeLocalLyricPath, changeLocalMusicPath } from "@/utils/helper";
import { songLevelData, getSongLevelsData } from "@/utils/meta";
import { pick } from "lodash-es";

const settingStore = useSettingStore();

// 默认下载音质选项
const downloadQualityOptions = computed(() => {
  const levels = pick(songLevelData, ["l", "m", "h", "sq", "hr", "je", "sk", "db", "jm"]);
  return getSongLevelsData(levels).map((item) => ({
    label: item.name,
    value: item.value,
  }));
});

const fileNameFormatOptions = [
  {
    label: "歌曲名",
    value: "title",
  },
  {
    label: "歌手 - 歌曲名",
    value: "artist-title",
  },
  {
    label: "歌曲名 - 歌手",
    value: "title-artist",
  },
];

const folderStrategyOptions = [
  {
    label: "不分文件夹",
    value: "none",
  },
  {
    label: "按歌手分文件夹",
    value: "artist",
  },
  {
    label: "按 歌手 \\ 专辑 分文件夹",
    value: "artist-album",
  },
];

// 选择下载路径
const choosePath = async () => {
  const path = await window.electron.ipcRenderer.invoke("choose-path");
  if (path) settingStore.downloadPath = path;
};

// 模拟播放下载开关
const handlePlaybackDownloadChange = (value: boolean) => {
  if (value) {
    window.$dialog.warning({
      title: "开启提示",
      content:
        "模拟播放下载可能导致部分音质歌词嵌入异常且未经完整测试可能有不稳定情况，确认要打开吗？",
      positiveText: "确认打开",
      negativeText: "取消",
      onPositiveClick: () => {
        settingStore.usePlaybackForDownload = true;
      },
    });
  } else {
    settingStore.usePlaybackForDownload = false;
  }
};
</script>

<style lang="scss" scoped>
#local-list-choose {
  .n-flex {
    width: 100%;
  }
  .n-collapse-transition {
    margin-top: 12px;
  }
}
</style>
