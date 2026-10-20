/* ------------------------------------------------------------------
 * 页面选择器。全部来自真实页面（长江雨课堂「学习空间」，地址形如
 * /ai-workspace/lms-graph/{课堂ID}/video/{学习项ID}?node_id=...），平台改版时只动这里。
 *
 * 目录（左侧「知识点」）：
 *   .nav-list                      滚动容器，内容远高于可视区
 *   .leaf-item[.is-active]         一个学习项；当前项带 is-active
 *     .leaf-item-tag               类型：视频 / 图文 / 课堂
 *     .leaf-item-title             标题
 *     .leaf-item-status            完成后里面有 i.icon-yuanquangou（圆圈勾），未完成为空
 *   .nav-item-node                 知识点节点
 *     i.expand-icon[.is-expanded]  只有带学习项的节点才有；折叠时节点下的学习项根本不渲染
 *
 * 播放器（「数字人」播放器）：
 *   video#video                    数字人讲师视频，讲解声音也在它上面
 *   .status-box .play-status-box   课件画面中间的大播放按钮
 *   .control-box                   控制栏，平时 display:none
 * ------------------------------------------------------------------ */
export const SEL = {
    navList: '.nav-list',
    leaf: '.nav-list .leaf-item',
    leafTag: '.leaf-item-tag',
    leafTitle: '.leaf-item-title',
    leafDone: '.leaf-item-status .icon-yuanquangou',
    expandIcon: '.nav-list .expand-icon',
    unitTitle: '.learning-space-control-unit .unit-title',
    unitRate: '.learning-space-control-unit .rate-detail .text',
    /* 实测这门课里有两套播放器，同一个课程目录下混着用，所以下面每一项都要同时认两套：
     *
     *   数字人播放器   .digital-human-player-box   video#video
     *                 大播放键 .play-status-box    控制栏 .control-box
     *                 倍速 .rate-config-item（文字 "2x"）
     *   xtplayer      .xtplayer                   video.xt_video_player（id 是动态生成的）
     *                 大播放键 .xt_video_bit_play_btn
     *                 控制栏 .xt_video_player_controls
     *                 倍速 .xt_video_player_common_list li（文字 "2.00X"）
     *
     * 两套都提供到 2x。只认 video#video 的话，xtplayer 那些视频会被判成"视频没加载"，
     * 哪怕它正在播——这是实测踩到的。 */
    player: '.digital-human-player-box, .xtplayer',
    video: 'video#video, video.xt_video_player',
    bigPlayButton: '.status-box .play-status-box, .xt_video_bit_play_btn',
    controlBox: '.control-box, .xt_video_player_controls',
    playButton: '.control-box .play-btn, .xt_video_player_play_btn',
    /* 静音：xtplayer 有个看门狗，我们设的 video.muted 会在一两秒内被它改回去
     * （实测事件序列 pause → volumechange → play → volumechange），只能点它自己的
     * 音量按钮，点一下 volume 归零并且保持得住。数字人播放器设 muted 就够了。 */
    volumeButton: '.volume-btn-box .volume-btn, .xt_video_player_volume .xt_video_player_common_icon',
    rateButton: '.rate-btn-box .rate-btn, .xt_video_player_speed .xt_video_player_common_value',
    /* 清晰度菜单(高清/标清)用的是同一个 common_list 类名, 所以要限定在倍速按钮里面 */
    rateMenuItem: '.rate-btn-box .rate-config-item, .xt_video_player_speed .xt_video_player_common_list li',
    /* Element UI 的弹窗。视频被暂停又恢复不了时看看是不是它挡着 */
    dialog: '.el-dialog__wrapper, .el-message-box__wrapper, [role="dialog"]',
};

export const KIND = {
    video: '视频',
    article: '图文',
    classroom: '课堂',
};

export const WORKSPACE_PATH = /\/ai-workspace\/lms-graph\//;
/* 脚本要接管的页面（学习空间）的地址特征 */
export const COURSE_PAGE = WORKSPACE_PATH;
/* 自动启动专用 Chrome 时打开的页面 */
export const HOME_URL = 'https://changjiang.yuketang.cn/';

export const ALLOWED_HOSTS = ['yuketang.cn'];

export function isAllowedUrl(url) {
    try {
        const { protocol, hostname } = new URL(url);
        if (protocol !== 'https:' && protocol !== 'http:') return false;
        const host = hostname.toLowerCase();
        return ALLOWED_HOSTS.some((base) => host === base || host.endsWith(`.${base}`));
    } catch (e) {
        return false;
    }
}
