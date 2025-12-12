/**
 * 列表滚动逻辑
 */
export const useListScroll = () => {
  const listScrolling = ref<boolean>(false);

  /**
   * 处理列表滚动
   */
  const handleListScroll = (e: Event) => {
    const scrollTop = (e.target as HTMLElement).scrollTop;
    listScrolling.value = scrollTop > 10;
  };

  /**
   * 重置滚动状态
   */
  const resetScroll = () => {
    listScrolling.value = false;
  };

  return {
    listScrolling,
    handleListScroll,
    resetScroll,
  };
};
