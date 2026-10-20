/* 页面选择器集中在这里，和浏览器内版本用的是同一套。
 * 平台改版时只需要动这个文件。 */
export const SEL = {
    tree: '#coursetree',
    /* 目录侧栏的展开/收起按钮。收起时整个侧栏 position:fixed 滑到视口右边外面,
     * 只有这个按钮露在视口右上角(实测) */
    catalogToggle: '#selector .switchbtn',
    chapter: '#coursetree > ul > li',
    section: '.posCatalog_select:not(.firstLayer)',
    sectionName: '.posCatalog_name',
    activeSection: '.posCatalog_active',
    /* 目录上的任务点标记(实测 mooc2): 有待完成任务点的小节带
     * <input type="hidden" class="jobUnfinishCount" value="N">, 完成的带 .icon_Completed,
     * 没有任务点的只有 .catalog_points_yi 里一个 <span class="orangeNew">0</span> */
    sectionUnfinished: '.jobUnfinishCount',
    sectionCompleted: '.icon_Completed',
    sectionPoints: '.catalog_points_yi .orangeNew',
    stepTab: '.prev_white',
    stepTitle: '.prev_title',
    testNext: '#prevNextFocusNext, #right1, .nextChapter',
    video: 'video#video_html5_api, video[id*="video_html5"]',
    bigPlayButton: '.vjs-big-play-button',
    playControl: '.vjs-play-control',
    /* 倍速：video.js 的菜单按钮。实测这个播放器提供 0.75 / 1 / 1.25 / 1.5 / 2 五档，
     * 菜单项文字形如 "2x"，当前选中的那条是 "1x, 选择"（带 .vjs-selected）。
     * 平台不让改倍速时这个控件根本不存在，那就不动它。 */
    player: '.video-js',
    controlBar: '.vjs-control-bar',
    rateButton: '.vjs-playback-rate button',
    rateMenuItem: '.vjs-playback-rate .vjs-menu-item',
};

export const ALLOWED_HOSTS = ['chaoxing.com'];

/* 自动启动专用 Chrome 时打开的页面：没登录会跳到登录页，登录了是课程列表 */
export const HOME_URL = 'https://i.chaoxing.com/';
/* 课程播放页（脚本要接管的页面）的地址特征 */
export const COURSE_PAGE = /\/mycourse\/studentstudy/;

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
