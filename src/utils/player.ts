import { type SongType, type PlayModeType } from "@/types/main";
import { type IFormat } from "music-metadata";
import { type MessageReactive } from "naive-ui";
import { cloneDeep } from "lodash-es";
import { useMusicStore, useStatusStore, useDataStore, useSettingStore } from "@/stores";
import { calculateProgress, msToS } from "./time";
import { shuffleArray, handleSongQuality } from "./helper";
import { heartRateList } from "@/api/playlist";
import { formatSongsList } from "./format";
import { isLogin } from "./auth";
import { openUserLogin } from "./modal";
import { personalFm, personalFmToTrash } from "@/api/rec";
import songManager, { type NextPrefetchSong } from "./songManager";
import { isElectron } from "./env";
import lyricManager from "./lyricManager";
import audioManager, { AudioEventType } from "./audioManager";
import blob from "./blob";

/**
 * 播放器核心
 * 基于 AudioManager 实现
 */
class Player {
  /** 自动关闭定时器 */
  private autoCloseInterval: ReturnType<typeof setInterval> | undefined;
  /** 其他数据 */
  private message: MessageReactive | null = null;
  /** 预载下一首歌曲播放地址缓存 */
  private nextPrefetch: NextPrefetchSong = null;
  /** 当前曲目重试信息（按歌曲维度计数） */
  private retryInfo: { songId: number; count: number } = { songId: 0, count: 0 };
  /** 存储事件回调函数的引用，用于清理 */
  private eventCallbacks: Map<AudioEventType, (e: Event) => void> = new Map();
  constructor() {
    // 初始化媒体会话
    this.initMediaSession();
    // 绑定音频事件
    this.bindAudioEvents();
  }
  /**
   * 解绑 AudioManager 事件
   */
  private unbindAudioEvents() {
    // 清理所有音频事件监听器
    this.eventCallbacks.forEach((callback, event) => {
      audioManager.off(event, callback);
    });
    this.eventCallbacks.clear();
  }
  /**
   * 绑定 AudioManager 事件
   */
  private bindAudioEvents() {
    // 清理可能存在的旧事件监听器
    this.unbindAudioEvents();
    // 播放
    const playCallback = () => {
      const statusStore = useStatusStore();
      const playSongData = songManager.getPlaySongData();
      const { name, artist } = songManager.getPlayerInfoObj() || {};
      const playTitle = `${name} - ${artist}`;
      window.document.title = `${playTitle} | SPlayer`;
      statusStore.playStatus = true;
      // 重置重试计数
      const sid = playSongData?.type === "radio" ? playSongData?.dj?.id : playSongData?.id;
      this.retryInfo = { songId: Number(sid || 0), count: 0 };
      // IPC 通知
      if (isElectron) {
        window.electron.ipcRenderer.send("play-status-change", true);
        window.electron.ipcRenderer.send("play-song-change", playTitle);
        window.electron.ipcRenderer.send("update-desktop-lyric-data", {
          playName: name,
          artistName: artist,
        });
      }
      console.log("▶️ song play:", playSongData);
    };
    audioManager.on("play", playCallback);
    this.eventCallbacks.set("play", playCallback);
    // 暂停
    const pauseCallback = () => {
      const statusStore = useStatusStore();
      const playSongData = songManager.getPlaySongData();
      statusStore.playStatus = false;
      if (!isElectron) window.document.title = "SPlayer";
      // IPC 通知
      if (isElectron) {
        window.electron.ipcRenderer.send("play-status-change", false);
      }
      console.log("⏸️ song pause:", playSongData);
    };
    audioManager.on("pause", pauseCallback);
    this.eventCallbacks.set("pause", pauseCallback);
    // 结束
    const endedCallback = () => {
      const statusStore = useStatusStore();
      const playSongData = songManager.getPlaySongData();
      console.log("⏹️ song end:", playSongData);
      // 检查自动关闭
      if (
        statusStore.autoClose.enable &&
        statusStore.autoClose.waitSongEnd &&
        statusStore.autoClose.remainTime <= 0
      ) {
        this.executeAutoClose();
        return;
      }
      this.nextOrPrev("next", true, true);
    };
    audioManager.on("ended", endedCallback);
    this.eventCallbacks.set("ended", endedCallback);
    // 错误
    const errorCallback = (e: Event) => {
      const playSongData = songManager.getPlaySongData();
      console.error("❌ song error:", playSongData, e);
      // 提取错误码
      let errCode: number | undefined;
      if ("detail" in e && e.detail) {
        errCode = (e.detail as { errorCode?: number }).errorCode;
      }
      this.handlePlaybackError(errCode);
    };
    audioManager.on("error", errorCallback);
    this.eventCallbacks.set("error", errorCallback);
    // 进度更新
    const timeupdateCallback = () => {
      const musicStore = useMusicStore();
      const statusStore = useStatusStore();
      const settingStore = useSettingStore();
      // 计算进度条距离
      const currentTime = Math.floor(audioManager.currentTime * 1000);
      const duration = Math.floor(audioManager.duration * 1000) || statusStore.duration;
      // 计算进度条
      const progress = calculateProgress(currentTime, duration);
      // 计算歌词索引
      const lyricIndex = lyricManager.calculateLyricIndex(currentTime);
      // 更新状态
      statusStore.$patch({ currentTime, duration, progress, lyricIndex });
      // 更新 MediaSession
      this.updateMediaSessionState(duration, currentTime);
      // 客户端事件
      if (isElectron) {
        // 歌词变化
        window.electron.ipcRenderer.send(
          "play-lyric-change",
          cloneDeep({
            lyricIndex,
            currentTime,
            songId: musicStore.playSong?.id,
            songOffset: statusStore.getSongOffset(musicStore.playSong?.id),
          }),
        );
        // 进度条
        if (settingStore.showTaskbarProgress) {
          window.electron.ipcRenderer.send("set-bar", progress);
        }
      }
    };
    audioManager.on("timeupdate", timeupdateCallback);
    this.eventCallbacks.set("timeupdate", timeupdateCallback);
    // 加载开始
    const loadstartCallback = () => {
      const statusStore = useStatusStore();
      statusStore.playLoading = true;
    };
    audioManager.on("loadstart", loadstartCallback);
    this.eventCallbacks.set("loadstart", loadstartCallback);
    // 可以播放
    const canplayCallback = () => {
      const statusStore = useStatusStore();
      statusStore.playLoading = false;
      // 恢复均衡器
      if (isElectron && statusStore.eqEnabled) {
        // 简单恢复 EQ 增益
        const bands = statusStore.eqBands;
        if (bands && bands.length === 10) {
          bands.forEach((val, idx) => audioManager.setFilterGain(idx, val));
        }
      }
      // IPC 通知
      if (isElectron) {
        const dataStore = useDataStore();
        const playSongData = songManager.getPlaySongData();
        window.electron.ipcRenderer.send("play-song-change", songManager.getPlayerInfo());
        window.electron.ipcRenderer.send(
          "like-status-change",
          dataStore.isLikeSong(playSongData?.id || 0),
        );
      }
    };
    audioManager.on("canplay", canplayCallback);
    this.eventCallbacks.set("canplay", canplayCallback);
  }
  /**
   * 创建播放器并播放
   * @param src 播放地址
   * @param autoPlay 是否自动播放
   * @param seek 播放位置
   */
  private async createPlayer(src: string, autoPlay: boolean = true, seek: number = 0) {
    // 获取数据
    const dataStore = useDataStore();
    const musicStore = useMusicStore();
    const statusStore = useStatusStore();
    const settingStore = useSettingStore();
    // 播放信息
    const { id, path, type } = musicStore.playSong;
    // 设置音量和速率
    audioManager.setVolume(statusStore.playVolume);
    audioManager.setRate(statusStore.playRate);
    // 播放设备
    if (!settingStore.showSpectrums) this.toggleOutputDevice();
    // 加载并播放
    try {
      await audioManager.play(src, { fadeIn: false, autoPlay });
      // 恢复进度
      if (seek && seek > 0) {
        audioManager.seek(seek / 1000);
      }
    } catch (err) {
      console.error("❌ 播放器初始化失败:", err);
      throw err;
    }
    // 获取歌词数据
    lyricManager.handleLyric(id, path);
    // 新增播放历史
    if (type !== "radio") dataStore.setHistory(musicStore.playSong);
    // 获取歌曲封面主色
    if (!path) songManager.getCoverColor(musicStore.songCover);
    // 更新 MediaSession
    if (!path) this.updateMediaSession();
    // 预载下一首播放地址
    if (settingStore.useNextPrefetch) {
      this.nextPrefetch = await songManager.getNextSongUrl();
    } else {
      this.nextPrefetch = null;
    }
  }
  /**
   * 初始化 MediaSession
   */
  private initMediaSession() {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.setActionHandler("play", () => this.play());
    navigator.mediaSession.setActionHandler("pause", () => this.pause());
    navigator.mediaSession.setActionHandler("previoustrack", () => this.nextOrPrev("prev"));
    navigator.mediaSession.setActionHandler("nexttrack", () => this.nextOrPrev("next"));
    navigator.mediaSession.setActionHandler("seekto", (event) => {
      const seekTime = event.seekTime ? Number(event.seekTime) * 1000 : 0;
      if (seekTime) this.setSeek(seekTime);
    });
  }
  /** 更新 MediaSession */
  private updateMediaSession() {
    if (!("mediaSession" in navigator)) return;
    const musicStore = useMusicStore();
    // 获取播放数据
    const playSongData = songManager.getPlaySongData();
    if (!playSongData) return;
    // 播放状态
    const isRadio = playSongData.type === "radio";
    // 获取数据
    const metaData: MediaMetadataInit = {
      title: playSongData.name,
      artist: isRadio
        ? "播客电台"
        : Array.isArray(playSongData.artists)
          ? playSongData.artists.map((item) => item.name).join(" / ")
          : String(playSongData.artists),
      album: isRadio
        ? "播客电台"
        : typeof playSongData.album === "object"
          ? playSongData.album.name
          : String(playSongData.album),
      artwork: [
        { src: musicStore.getSongCover("cover"), sizes: "512x512", type: "image/jpeg" },
        { src: musicStore.getSongCover("s"), sizes: "100x100", type: "image/jpeg" },
        { src: musicStore.getSongCover("m"), sizes: "300x300", type: "image/jpeg" },
        { src: musicStore.getSongCover("l"), sizes: "1024x1024", type: "image/jpeg" },
        { src: musicStore.getSongCover("xl"), sizes: "1920x1920", type: "image/jpeg" },
      ],
    };
    navigator.mediaSession.metadata = new window.MediaMetadata(metaData);
  }
  /**
   * 实时更新 MediaSession
   * @param duration 歌曲总时长（毫秒）
   * @param currentTime 当前播放时间（毫秒）
   */
  private updateMediaSessionState(duration: number, currentTime: number) {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.setPositionState({
      duration: msToS(duration),
      position: msToS(currentTime),
    });
  }
  /**
   * 获取频谱数据
   */
  getSpectrumData(): Uint8Array | null {
    return audioManager.getFrequencyData();
  }
  /**
   * 集中处理播放错误与重试策略
   */
  private async handlePlaybackError(errCode?: number) {
    const dataStore = useDataStore();
    const playSongData = songManager.getPlaySongData();
    const currentSongId = playSongData?.type === "radio" ? playSongData.dj?.id : playSongData?.id;
    // 保存当前播放进度，用于恢复
    const currentSeek = this.getSeek();
    // 初始化/切换曲目时重置计数
    if (!this.retryInfo.songId || this.retryInfo.songId !== Number(currentSongId || 0)) {
      this.retryInfo = { songId: Number(currentSongId || 0), count: 0 };
    }
    this.retryInfo.count += 1;
    // 如果错误码未定义或为 0，且重试次数过多，直接跳过避免无限重试
    if ((errCode === undefined || errCode === 0) && this.retryInfo.count > 2) {
      console.warn("⚠️ 未知错误且重试次数过多，跳过重试:", {
        count: this.retryInfo.count,
        errCode,
      });
      this.retryInfo.count = 0;
      if (dataStore.playList.length > 1) {
        window.$message.error("播放失败，已跳至下一首");
        await this.nextOrPrev("next");
      } else {
        window.$message.error("当前列表暂无可播放歌曲");
        this.cleanPlayList();
      }
      return;
    }
    // 1：用户中止了加载，不进行重试
    if (errCode === 1) {
      console.log("⏸️ 用户中止播放，不进行重试");
      this.retryInfo.count = 0;
      return;
    }
    // 4：音频格式不被支持，直接跳到下一首
    if (errCode === 4) {
      console.error("❌ 音频格式不支持:", { songId: currentSongId, errorCode: errCode });
      this.retryInfo.count = 0;
      if (dataStore.playList.length > 1) {
        window.$message.error("音频格式不支持，已跳至下一首");
        await this.nextOrPrev("next");
      } else {
        window.$message.error("当前列表暂无可播放歌曲");
        this.cleanPlayList();
      }
      return;
    }
    // 3：解码错误，通常无法通过重试解决，减少重试次数
    if (errCode === 3) {
      if (this.retryInfo.count <= 1) {
        console.log("🔄 检测到解码错误，尝试重试:", { count: this.retryInfo.count });
        if (this.retryInfo.count === 1) {
          window.$message.info("播放出现问题，正在尝试恢复...");
        }
        await this.initPlayer(true, currentSeek);
        return;
      }
      // 解码错误重试 1 次后直接跳过
      console.error("❌ 解码错误，重试失败:", { songId: currentSongId, errorCode: errCode });
      this.retryInfo.count = 0;
      if (dataStore.playList.length > 1) {
        window.$message.error("音频解码失败，已跳至下一首");
        await this.nextOrPrev("next");
      } else {
        window.$message.error("当前列表暂无可播放歌曲");
        this.cleanPlayList();
      }
      return;
    }
    // 2：资源过期或临时网络错误（通常是长时间暂停导致URL过期）
    if (errCode === 2 && this.retryInfo.count <= 2) {
      console.log("🔄 检测到资源过期，重新获取播放地址并从原位置继续:", currentSeek);
      await this.initPlayer(true, currentSeek);
      return;
    }
    // 其它错误：最多 3 次，首次重试从原位置开始
    if (this.retryInfo.count <= 3) {
      const seekPosition = this.retryInfo.count === 1 ? currentSeek : 0;
      console.log("🔄 播放出错，尝试重试:", { count: this.retryInfo.count, seekPosition, errCode });
      // 只在第一次重试时显示提示，避免过于频繁
      if (this.retryInfo.count === 1) {
        window.$message.info("播放出现问题，正在尝试恢复...");
      }
      await this.initPlayer(true, seekPosition);
      return;
    }
    // 超过次数：切到下一首或清空
    this.retryInfo.count = 0;
    if (dataStore.playList.length > 1) {
      window.$message.error("当前歌曲播放失败，已跳至下一首");
      await this.nextOrPrev("next");
    } else {
      window.$message.error("当前列表暂无可播放歌曲");
      this.cleanPlayList();
    }
  }
  /**
   * 获取本地歌曲元信息
   * @param path 歌曲路径
   */
  private async parseLocalMusicInfo(path: string) {
    try {
      const musicStore = useMusicStore();
      const statusStore = useStatusStore();
      // 清理旧的 blob URL（如果存在）
      const oldCover = musicStore.playSong.cover;
      const oldPath = musicStore.playSong.path;
      if (oldCover && oldCover.startsWith("blob:") && oldPath && oldPath !== path) {
        blob.revokeBlobURL(oldPath);
      }
      // 获取封面数据
      const coverData = await window.electron.ipcRenderer.invoke("get-music-cover", path);
      if (coverData) {
        const { data, format } = coverData;
        const blobURL = blob.createBlobURL(data, format, path);
        if (blobURL) musicStore.playSong.cover = blobURL;
      } else {
        musicStore.playSong.cover = "/images/song.jpg?assest";
      }
      // 更新媒体会话
      this.updateMediaSession();
      // 获取元数据
      const infoData: { format: IFormat } = await window.electron.ipcRenderer.invoke(
        "get-music-metadata",
        path,
      );
      // 更新音质
      statusStore.songQuality = handleSongQuality(infoData.format.bitrate ?? 0);
      // 获取主色
      songManager.getCoverColor(musicStore.playSong.cover);
    } catch (error) {
      window.$message.error("获取本地歌曲元信息失败");
      console.error("Failed to parse local music info:", error);
    }
  }
  /**
   * 重置状态
   */
  public resetStatus() {
    this.nextPrefetch = null;
    const musicStore = useMusicStore();
    const statusStore = useStatusStore();
    const settingStore = useSettingStore();
    // 重置状态
    statusStore.$patch({
      currentTime: 0,
      duration: 0,
      progress: 0,
      lyricIndex: -1,
      playStatus: false,
      playLoading: false,
    });
    musicStore.playPlaylistId = 0;
    musicStore.resetMusicData();
    if (settingStore.showTaskbarProgress) {
      window.electron.ipcRenderer.send("set-bar", "none");
    }
  }
  /**
   * 初始化播放器
   * 核心外部调用
   * @param autoPlay 是否自动播放
   * @param seek 播放位置
   */
  public async initPlayer(autoPlay: boolean = true, seek: number = 0) {
    const dataStore = useDataStore();
    const musicStore = useMusicStore();
    const statusStore = useStatusStore();
    const settingStore = useSettingStore();
    try {
      // 获取播放数据
      const playSongData = songManager.getPlaySongData();
      if (!playSongData) {
        statusStore.playLoading = false;
        return;
      }
      const { id, dj, path, type } = playSongData;
      // 更改当前播放歌曲
      musicStore.playSong = playSongData;
      statusStore.playLoading = true;
      // 停止当前播放
      audioManager.stop();
      // 本地歌曲
      if (path) {
        try {
          await this.createPlayer(`file://${path}`, autoPlay, seek);
          await this.parseLocalMusicInfo(path);
        } catch (err) {
          console.error("播放器初始化错误（本地）：", err);
          // createPlayer 内部已触发 handlePlaybackError，这里只记录日志
          // 如果 createPlayer 没有触发错误处理，则手动触发
          const errCode = audioManager.getErrorCode();
          if (errCode === 0) {
            // 如果没有错误码，可能是其他类型的错误，触发通用错误处理
            await this.handlePlaybackError(undefined);
          }
        }
      }
      // 在线歌曲
      else if (id && (dataStore.playList.length || statusStore.personalFmMode)) {
        // 播放地址
        let playerUrl: string | null = null;

        // 获取歌曲 URL 单独 try-catch
        try {
          const songId = type === "radio" ? dj?.id : id;
          if (!songId) throw new Error("获取歌曲 ID 失败");

          // 使用预载缓存
          const cached = this.nextPrefetch;
          if (settingStore.useNextPrefetch && cached && cached.id === songId && cached.url) {
            playerUrl = cached.url;
            statusStore.playUblock = cached.ublock;
            statusStore.songQuality = cached.quality;
          } else {
            const canUnlock = isElectron && type !== "radio" && settingStore.useSongUnlock;
            const { url: officialUrl, isTrial, quality } = await songManager.getOnlineUrl(songId);
            // 更新音质
            statusStore.songQuality = quality;
            // 更新播放地址
            if (officialUrl && !isTrial) {
              playerUrl = officialUrl;
              statusStore.playUblock = false;
            } else if (canUnlock) {
              const unlockUrl = await songManager.getUnlockSongUrl(playSongData);
              if (unlockUrl) {
                playerUrl = unlockUrl;
                statusStore.playUblock = true;
                console.log("🎼 Song unlock successfully:", unlockUrl);
              } else if (officialUrl && isTrial && settingStore.playSongDemo) {
                window.$message.warning("当前歌曲仅可试听，请开通会员后重试");
                playerUrl = officialUrl;
                statusStore.playUblock = false;
              } else {
                playerUrl = null;
              }
            } else {
              playerUrl = null;
            }
          }

          if (!playerUrl) {
            window.$message.error("该歌曲暂无音源，跳至下一首");
            await this.nextOrPrev("next");
            return;
          }
        } catch (err) {
          console.error("❌ 获取歌曲地址出错：", err);
          window.$message.error("获取歌曲地址失败，跳至下一首");
          await this.nextOrPrev("next");
          return;
        }
        // 有有效 URL 才创建播放器
        if (playerUrl) {
          try {
            await this.createPlayer(playerUrl, autoPlay, seek);
          } catch (err) {
            console.error("播放器初始化错误（在线）：", err);
            // createPlayer 内部已触发 handlePlaybackError，这里只记录日志
            // 如果 createPlayer 没有触发错误处理，则手动触发
            const errCode = audioManager.getErrorCode();
            if (errCode === 0) {
              // 如果没有错误码，可能是其他类型的错误，触发通用错误处理
              await this.handlePlaybackError(undefined);
            }
          }
        }
      }
    } catch (err) {
      console.error("❌ 初始化音乐播放器出错：", err);
      window.$message.error("播放遇到错误，尝试下一首");
      await this.nextOrPrev("next");
    }
  }
  /**
   * 播放
   */
  async play() {
    const statusStore = useStatusStore();
    const settingStore = useSettingStore();
    // 检查播放器状态
    if (!audioManager.src) {
      window.$message.warning("播放器未就绪，请稍后重试");
      return;
    }
    // 已在播放
    if (!audioManager.paused) {
      statusStore.playStatus = true;
      return;
    }
    const fadeTime = settingStore.getFadeTime ? settingStore.getFadeTime / 1000 : 0;
    await audioManager.play(undefined, { fadeIn: !!fadeTime, fadeDuration: fadeTime });
  }
  /**
   * 暂停
   * @param changeStatus 是否更改播放状态
   */
  public async pause(changeStatus: boolean = true) {
    const statusStore = useStatusStore();
    const settingStore = useSettingStore();
    if (!audioManager.src) return;
    if (changeStatus) statusStore.playStatus = false;
    // 淡出
    const fadeTime = settingStore.getFadeTime ? settingStore.getFadeTime / 1000 : 0;
    audioManager.pause({ fadeOut: !!fadeTime, fadeDuration: fadeTime });
  }
  /**
   * 播放或暂停
   */
  public async playOrPause() {
    const statusStore = useStatusStore();
    if (statusStore.playStatus) await this.pause();
    else await this.play();
  }
  /**
   * 下一首或上一首
   * @param type 切换类别 next 下一首 prev 上一首
   * @param play 是否立即播放
   * @param autoEnd 是否为歌曲自动播放结束
   */
  public async nextOrPrev(
    type: "next" | "prev" = "next",
    play: boolean = true,
    autoEnd: boolean = false,
  ) {
    const statusStore = useStatusStore();
    const dataStore = useDataStore();
    const musicStore = useMusicStore();
    try {
      // 立即更新UI状态，防止用户重复点击
      statusStore.playLoading = true;
      statusStore.playStatus = false;
      // 获取数据
      const { playList } = dataStore;
      const { playSong } = musicStore;
      const { playSongMode, playHeartbeatMode } = statusStore;
      // 若为私人FM
      if (statusStore.personalFmMode) {
        await this.initPersonalFM(true);
        return;
      }
      // 列表长度
      const playListLength = playList.length;
      // 播放列表是否为空
      if (playListLength === 0) {
        window.$message.error("播放列表为空，请添加歌曲");
        return;
      }
      // 只有一首歌的特殊处理
      if (playListLength === 1) {
        statusStore.playLoading = false;
        this.setSeek(0);
        await this.play();
        return;
      }
      // 单曲循环
      if (playSongMode === "repeat-once" && autoEnd && !playHeartbeatMode) {
        statusStore.playLoading = false;
        this.setSeek(0);
        await this.play();
        return;
      }
      // 列表循环、单曲循环（手动切歌）、处于心动模式或随机模式
      if (
        playSongMode === "repeat" ||
        playSongMode === "repeat-once" ||
        playSongMode === "shuffle" ||
        playHeartbeatMode ||
        playSong.type === "radio"
      ) {
        statusStore.playIndex += type === "next" ? 1 : -1;
      } else {
        throw new Error("The play mode is not supported");
      }
      // 索引是否越界
      if (statusStore.playIndex < 0) {
        statusStore.playIndex = playListLength - 1;
      } else if (statusStore.playIndex >= playListLength) {
        statusStore.playIndex = 0;
      }
      // 重置播放进度
      statusStore.currentTime = 0;
      statusStore.progress = 0;
      // 初始化播放器（不传入seek参数，确保从头开始播放）
      await this.initPlayer(play, 0);
    } catch (error) {
      console.error("Error in nextOrPrev:", error);
      statusStore.playLoading = false;
      throw error;
    }
  }
  /**
   * 切换播放模式
   */
  public async togglePlayMode(mode: PlayModeType | false) {
    this.nextPrefetch = null;
    const statusStore = useStatusStore();
    const dataStore = useDataStore();
    const musicStore = useMusicStore();
    // 退出心动模式
    if (statusStore.playHeartbeatMode) this.toggleHeartMode(false);
    // 计算目标模式
    let targetMode: PlayModeType;
    if (mode) {
      targetMode = mode;
    } else {
      switch (statusStore.playSongMode) {
        case "repeat":
          targetMode = "repeat-once";
          break;
        case "shuffle":
          targetMode = "repeat";
          break;
        case "repeat-once":
          targetMode = "shuffle";
          break;
        default:
          targetMode = "repeat";
      }
    }
    // 进入随机模式：保存原顺序并打乱当前歌单
    if (targetMode === "shuffle" && statusStore.playSongMode !== "shuffle") {
      const currentList = dataStore.playList;
      if (currentList && currentList.length > 1) {
        const currentSongId = musicStore.playSong?.id;
        await dataStore.setOriginalPlayList(currentList);
        const shuffled = shuffleArray(currentList);
        await dataStore.setPlayList(shuffled);
        if (currentSongId) {
          const newIndex = shuffled.findIndex((s) => s?.id === currentSongId);
          if (newIndex !== -1) useStatusStore().playIndex = newIndex;
        }
      }
    }
    // 离开随机模式：恢复到原顺序
    if (
      statusStore.playSongMode === "shuffle" &&
      (targetMode === "repeat" || targetMode === "repeat-once")
    ) {
      const original = await dataStore.getOriginalPlayList();
      if (original && original.length) {
        const currentSongId = musicStore.playSong?.id;
        await dataStore.setPlayList(original);
        if (currentSongId) {
          const origIndex = original.findIndex((s) => s?.id === currentSongId);
          useStatusStore().playIndex = origIndex !== -1 ? origIndex : 0;
        } else {
          useStatusStore().playIndex = 0;
        }
        await dataStore.clearOriginalPlayList();
      }
    }
    // 应用模式
    statusStore.playSongMode = targetMode;
    this.playModeSyncIpc();
  }
  /**
   * 播放模式同步 ipc
   */
  public playModeSyncIpc() {
    const statusStore = useStatusStore();
    if (isElectron) {
      window.electron.ipcRenderer.send("play-mode-change", statusStore.playSongMode);
    }
  }
  /**
   * 设置播放进度
   * @param time 播放进度（单位：毫秒）
   */
  public setSeek(time: number) {
    const statusStore = useStatusStore();
    if (time < 0 || time > this.getDuration()) {
      time = Math.max(0, Math.min(time, this.getDuration()));
    }
    audioManager.seek(time / 1000);
    statusStore.currentTime = time;
  }
  /**
   * 获取播放进度
   * @returns 播放进度（单位：毫秒）
   */
  public getSeek(): number {
    return Math.floor(audioManager.currentTime * 1000);
  }
  /**
   * 获取播放时长
   * @returns 播放时长（单位：毫秒）
   */
  public getDuration(): number {
    return Math.floor(audioManager.duration * 1000);
  }
  /**
   * 设置播放速率
   */
  public setRate(rate: number) {
    const statusStore = useStatusStore();
    audioManager.setRate(rate);
    statusStore.playRate = rate;
  }

  /**
   * 设置播放音量
   */
  public setVolume(actions: number | "up" | "down" | WheelEvent) {
    const statusStore = useStatusStore();
    const increment = 0.05;

    if (typeof actions === "number") {
      actions = Math.max(0, Math.min(actions, 1));
      statusStore.playVolume = actions;
    } else if (actions === "up" || actions === "down") {
      statusStore.playVolume = Math.max(
        0,
        Math.min(statusStore.playVolume + (actions === "up" ? increment : -increment), 1),
      );
    } else {
      const deltaY = actions.deltaY;
      const volumeChange = deltaY > 0 ? -increment : increment;
      statusStore.playVolume = Math.max(0, Math.min(statusStore.playVolume + volumeChange, 1));
    }

    audioManager.setVolume(statusStore.playVolume);
  }

  /**
   * 切换静音
   */
  public toggleMute() {
    const statusStore = useStatusStore();
    const isMuted = statusStore.playVolume === 0;

    if (isMuted) {
      statusStore.playVolume = statusStore.playVolumeMute;
    } else {
      statusStore.playVolumeMute = audioManager.getVolume();
      statusStore.playVolume = 0;
    }
    audioManager.setVolume(statusStore.playVolume);
  }

  /**
   * 更新播放列表
   * @param data 播放列表
   * @param song 当前播放歌曲
   * @param pid 播放列表id
   * @param options 配置
   * @param options.showTip 是否显示提示
   * @param options.scrobble 是否打卡
   * @param options.play 是否直接播放
   */
  public async updatePlayList(
    data: SongType[],
    song?: SongType,
    pid?: number,
    options: {
      showTip?: boolean;
      scrobble?: boolean;
      play?: boolean;
      keepHeartbeatMode?: boolean;
    } = {
      showTip: true,
      scrobble: true,
      play: true,
    },
  ) {
    this.nextPrefetch = null;
    if (!data || !data.length) return;
    const dataStore = useDataStore();
    const musicStore = useMusicStore();
    const statusStore = useStatusStore();
    // 获取配置
    const { showTip, play } = options;
    // 处理随机播放模式
    let processedData = cloneDeep(data);
    if (statusStore.playSongMode === "shuffle") {
      // 保存原始播放列表
      await dataStore.setOriginalPlayList(cloneDeep(data));
      // 随机排序
      processedData = shuffleArray(processedData);
    }
    // 更新列表
    await dataStore.setPlayList(processedData);
    // 关闭特殊模式
    if (statusStore.playHeartbeatMode && !options.keepHeartbeatMode) {
      this.toggleHeartMode(false);
    }
    if (statusStore.personalFmMode) statusStore.personalFmMode = false;
    // 是否直接播放
    if (song && typeof song === "object" && "id" in song) {
      // 是否为当前播放歌曲
      if (musicStore.playSong.id === song.id) {
        if (play) await this.play();
      } else {
        // 查找索引（在处理后的列表中查找）
        statusStore.playIndex = processedData.findIndex((item) => item.id === song.id);
        // 播放
        await this.initPlayer();
      }
    } else {
      statusStore.playIndex =
        statusStore.playSongMode === "shuffle"
          ? Math.floor(Math.random() * processedData.length)
          : 0;
      await this.initPlayer();
    }
    musicStore.playPlaylistId = pid ?? 0;
    if (showTip) window.$message.success("已开始播放");
  }

  /**
   * 添加下一首歌曲
   * @param song 歌曲
   * @param play 是否立即播放
   */
  public async addNextSong(song: SongType, play: boolean = false) {
    const dataStore = useDataStore();
    const musicStore = useMusicStore();
    const statusStore = useStatusStore();
    // 关闭特殊模式
    if (statusStore.personalFmMode) statusStore.personalFmMode = false;

    if (musicStore.playSong.id === song.id) {
      this.play();
      window.$message.success("已开始播放");
      return;
    }
    // 尝试添加
    const currentSongId = musicStore.playSong.id;
    const songIndex = await dataStore.setNextPlaySong(song, statusStore.playIndex);
    // 播放歌曲
    if (songIndex < 0) return;
    if (play) {
      this.togglePlayIndex(songIndex, true);
    } else {
      // 修正当前播放索引
      const newCurrentIndex = dataStore.playList.findIndex((s) => s.id === currentSongId);
      if (newCurrentIndex !== -1 && newCurrentIndex !== statusStore.playIndex) {
        statusStore.playIndex = newCurrentIndex;
      }
      window.$message.success("已添加至下一首播放");
    }
  }
  /**
   * 切换播放索引
   * @param index 播放索引
   * @param play 是否立即播放
   */
  public async togglePlayIndex(index: number, play: boolean = false) {
    const dataStore = useDataStore();
    const statusStore = useStatusStore();
    try {
      // 立即更新UI状态，防止用户重复点击
      statusStore.playLoading = true;
      statusStore.playStatus = false;
      // 获取数据
      const { playList } = dataStore;
      // 若超出播放列表
      if (index >= playList.length) return;
      // 相同
      if (!play && statusStore.playIndex === index) {
        this.play();
        return;
      }
      // 更改状态
      statusStore.playIndex = index;
      // 重置播放进度（切换歌曲时必须重置）
      statusStore.currentTime = 0;
      statusStore.progress = 0;
      statusStore.lyricIndex = -1;
      await this.initPlayer(true, 0);
    } catch (error) {
      console.error("Error in togglePlayIndex:", error);
      statusStore.playLoading = false;
      throw error;
    }
  }
  /**
   * 移除指定歌曲
   * @param index 歌曲索引
   */
  public removeSongIndex(index: number) {
    const dataStore = useDataStore();
    const statusStore = useStatusStore();
    // 获取数据
    const { playList } = dataStore;
    // 若超出播放列表
    if (index >= playList.length) return;
    // 仅剩一首
    if (playList.length === 1) {
      this.cleanPlayList();
      return;
    }
    // 是否为当前播放歌曲
    const isCurrentPlay = statusStore.playIndex === index;
    // 深拷贝，防止影响原数据
    const newPlaylist = cloneDeep(playList);
    // 若将移除最后一首
    if (index === playList.length - 1) {
      statusStore.playIndex = 0;
    }
    // 若为当前播放之后
    else if (statusStore.playIndex > index) {
      statusStore.playIndex--;
    }
    // 移除指定歌曲
    newPlaylist.splice(index, 1);
    dataStore.setPlayList(newPlaylist);
    // 若为当前播放
    if (isCurrentPlay) {
      this.initPlayer(statusStore.playStatus);
    }
  }
  /**
   * 清空播放列表
   */
  public async cleanPlayList() {
    const dataStore = useDataStore();
    const statusStore = useStatusStore();
    audioManager.stop();
    this.resetStatus();
    statusStore.$patch({
      playListShow: false,
      showFullPlayer: false,
      playHeartbeatMode: false,
      personalFmMode: false,
      playIndex: -1,
    });
    await dataStore.setPlayList([]);
    await dataStore.clearOriginalPlayList();
  }
  /**
   * 切换输出设备
   * @param deviceId 输出设备
   */
  public toggleOutputDevice(deviceId?: string) {
    try {
      const settingStore = useSettingStore();
      const device = deviceId ?? settingStore.playDevice;
      if (device) {
        audioManager.setSinkId(device);
      }
    } catch (error) {
      console.error("Failed to change audio output device:", error);
    }
  }
  /**
   * 启用/更新均衡器
   * @param options 均衡器选项
   */
  public enableEq(options?: {
    bands?: number[];
    preamp?: number;
    q?: number;
    frequencies?: number[];
  }) {
    // 暂未完全适配 preamp 和 q 的动态调整，仅处理 bands
    if (options?.bands) {
      options.bands.forEach((val, idx) => audioManager.setFilterGain(idx, val));
    }
  }
  /**
   * 更新均衡器
   * @param options 均衡器选项
   */
  public updateEq(options: { bands?: number[]; preamp?: number; q?: number }) {
    this.enableEq(options);
  }
  /**
   * 禁用均衡器并恢复直出（保持频谱可用）
   */
  public disableEq() {
    // 将所有频段增益设为 0
    for (let i = 0; i < 10; i++) {
      audioManager.setFilterGain(i, 0);
    }
  }
  /**
   * 切换桌面歌词
   */
  public toggleDesktopLyric() {
    const statusStore = useStatusStore();
    const show = !statusStore.showDesktopLyric;
    statusStore.showDesktopLyric = show;
    window.electron.ipcRenderer.send("toggle-desktop-lyric", show);
    window.$message.success(`${show ? "已开启" : "已关闭"}桌面歌词`);
  }
  /**
   * 显式设置桌面歌词显示/隐藏
   * @param show 是否显示
   */
  public setDesktopLyricShow(show: boolean) {
    const statusStore = useStatusStore();
    if (statusStore.showDesktopLyric === show) return;
    statusStore.showDesktopLyric = show;
    window.electron.ipcRenderer.send("toggle-desktop-lyric", show);
    window.$message.success(`${show ? "已开启" : "已关闭"}桌面歌词`);
  }
  /**
   * 切换心动模式
   * @param open 是否开启
   */
  public async toggleHeartMode(open: boolean = true) {
    try {
      const dataStore = useDataStore();
      const musicStore = useMusicStore();
      const statusStore = useStatusStore();
      if (!open && statusStore.playHeartbeatMode) {
        this.nextPrefetch = null;
        statusStore.playHeartbeatMode = false;
        window.$message.success("已退出心动模式");
        return;
      }
      if (isLogin() !== 1) {
        if (isLogin() === 0) {
          openUserLogin(true);
        } else {
          window.$message.warning("该登录模式暂不支持该操作");
        }
        return;
      }
      if (statusStore.playHeartbeatMode) {
        window.$message.warning("已处于心动模式");
        this.play();
        return;
      }
      this.message?.destroy();
      this.message = window.$message.loading("心动模式开启中", { duration: 0 });
      const playSongData = songManager.getPlaySongData();
      const likeSongsList = await dataStore.getUserLikePlaylist();
      const pid =
        musicStore.playPlaylistId && musicStore.playPlaylistId !== 0
          ? musicStore.playPlaylistId
          : (likeSongsList?.detail?.id ?? 0);
      // 获取心动模式歌曲列表
      const result = await heartRateList(playSongData?.id || 0, pid);
      if (result.code === 200) {
        this.message?.destroy();
        const heartRatelists = formatSongsList(result.data);
        this.nextPrefetch = null;
        statusStore.playIndex = 0;
        // 先更新播放列表，再设置心动模式标志
        await this.updatePlayList(heartRatelists, heartRatelists[0], undefined, {
          showTip: true,
          scrobble: true,
          play: true,
          keepHeartbeatMode: true,
        });
        statusStore.playHeartbeatMode = true;
      } else {
        this.message?.destroy();
        window.$message.error(result.message || "心动模式开启出错，请重试");
      }
    } catch (error) {
      console.error("Failed to toggle heart mode:", error);
      this.message?.destroy();
      window.$message.error("心动模式开启出错，请重试");
    } finally {
      this.message?.destroy();
    }
  }
  /**
   * 初始化私人FM
   * @param playNext 是否播放下一首
   */
  public async initPersonalFM(playNext: boolean = false) {
    this.nextPrefetch = null;
    const musicStore = useMusicStore();
    const statusStore = useStatusStore();
    try {
      const getPersonalFmData = async () => {
        const result = await personalFm();
        const songData = formatSongsList(result.data);
        console.log(`🌐 personal FM:`, songData);
        musicStore.personalFM.list = songData;
        musicStore.personalFM.playIndex = 0;
      };
      // 若列表为空或已播放到最后，获取新列表
      if (musicStore.personalFM.list.length === 0) await getPersonalFmData();
      if (playNext) {
        statusStore.personalFmMode = true;
        if (musicStore.personalFM.playIndex < musicStore.personalFM.list.length - 1) {
          musicStore.personalFM.playIndex++;
        } else {
          await getPersonalFmData();
        }
        await this.initPlayer();
      }
    } catch (error) {
      console.error("Failed to initialize personal FM:", error);
    }
  }
  /**
   * 私人FM - 垃圾桶
   * @param id 歌曲ID
   */
  public async personalFMTrash(id: number) {
    try {
      const statusStore = useStatusStore();
      if (!isLogin()) {
        openUserLogin(true);
        return;
      }
      statusStore.personalFmMode = true;
      statusStore.playHeartbeatMode = false;
      const result = await personalFmToTrash(id);
      if (result.code === 200) {
        window.$message.success("已移至垃圾桶");
        this.nextOrPrev("next");
      }
    } catch (error) {
      console.error("Error adding to trash:", error);
      window.$message.error("移至垃圾桶失败，请重试");
    }
  }
  /**
   * 开始定时关闭
   */
  public startAutoCloseTimer(time: number, remainTime: number) {
    const statusStore = useStatusStore();
    if (!time || !remainTime) return;
    if (this.autoCloseInterval) {
      clearInterval(this.autoCloseInterval);
      this.autoCloseInterval = undefined;
    }
    Object.assign(statusStore.autoClose, {
      enable: true,
      time,
      remainTime,
    });
    this.autoCloseInterval = setInterval(() => {
      if (statusStore.autoClose.remainTime <= 0) {
        clearInterval(this.autoCloseInterval);
        this.autoCloseInterval = undefined;
        if (!statusStore.autoClose.waitSongEnd) {
          this.executeAutoClose();
        }
        return;
      }
      statusStore.autoClose.remainTime--;
    }, 1000);
  }
  /**
   * 执行自动关闭
   */
  private executeAutoClose() {
    console.log("🔄 执行自动关闭");
    this.pause();
    const { autoClose } = useStatusStore();
    autoClose.enable = false;
    autoClose.remainTime = autoClose.time * 60;
  }
}

let _player: Player | null = null;

/**
 * 获取播放器实例
 * @returns Player
 */
export const usePlayer = (): Player => {
  if (!_player) _player = new Player();
  return _player;
};
