/** One wry line a day, signed by the product. The date picks it, so a reload
 *  during the same day keeps the same line. */
export const SOUP_AUTHOR = '犇马';

export const DAILY_SOUP = [
    '你努力的样子，老板都看在眼里，所以他换了辆新车。',
    '只要肯吃苦，就有吃不完的苦。',
    '你不是没有时间，你只是把时间都用来焦虑了。',
    '今天的事今天做不完，明天还有明天的。',
    '你离成功只差一步：先睡一觉，明天再说。',
    '每一次想放弃的时候，想想当初为什么坚持到现在——然后就可以放心放弃了。',
    '你想要的都在路上，只是堵车了。',
    '不是所有努力都有回报，但不努力一定很舒服。',
    '你对未来最大的贡献，就是没有去创业。',
    '别怕失败，失败了也没人记得。',
    '你的潜力很大，大到你自己都挖不出来。',
    '别人加班是奋斗，你加班是还债。',
    '时间会证明一切，也会证明你拖了多久。',
    '你不是迷茫，你只是选择太多，一个都不想选。',
    '只要方向对了，就不怕路远——怕的是你根本不动。',
    '你总说自己没准备好，机会从来没等过你。',
    '人生的意义在于折腾，折腾完你会发现还是躺着好。',
    '你羡慕的生活，背后都有你吃不了的苦。',
    '今天不努力，明天努力找借口。',
    '你负责精彩，老天自有安排——安排你加班。',
    '梦想还是要有的，万一见鬼了呢。',
    '别把世界让给你讨厌的人，他们已经在加班了。',
    '你以为的极限，只是别人的起点。',
    '生活不止眼前的苟且，还有明年的苟且。',
    '你不是在等机会，你是在等下班。',
    '别人是赢在起跑线，你是赢在起跑线旁边看热闹。',
    '不要因为走得太远，就忘了当初为什么出发——反正也走不远。',
    '生活给你关上一扇门，还会顺手关掉你的窗。',
    '你缺的不是机会，是接住机会的本事。',
    '今天也要加油，不然明天连借口都不好找。',
] as const;

/** Matching indices preserve the day’s quote when the interface language changes. */
const ENGLISH_SOUP = [
    "Your boss noticed all your hard work. That is why he bought a new car.",
    "If you are willing to suffer, there is always more work waiting.",
    "You do have time. You spent it all worrying.",
    "If today’s work does not get done today, tomorrow has its own work too.",
    "You are one step from success: get some sleep and deal with it tomorrow.",
    "When you want to give up, remember why you kept going this long. Then give up with peace of mind.",
    "Everything you want is on its way. It is just stuck in traffic.",
    "Not every effort pays off. Doing nothing, however, is very comfortable.",
    "Your greatest contribution to the future is that you did not start a company.",
    "Do not fear failure. Nobody will remember it anyway.",
    "Your potential is enormous. Even you cannot find the bottom of it.",
    "For others, overtime is ambition. For you, it is debt repayment.",
    "Time will prove everything, including how long you procrastinated.",
    "You are not lost. You just have too many options and want none of them.",
    "The right direction makes distance manageable. Moving at all is the hard part.",
    "You keep saying you are not ready. Opportunity never agreed to wait.",
    "Life is about trying things. Afterwards, you may find lying down was better.",
    "The life you envy comes with hardships you would rather skip.",
    "If you do not work hard today, work hard on tomorrow’s excuses.",
    "You bring the brilliance. Fate brings the overtime.",
    "Keep your dreams. Something strange might happen.",
    "Do not leave the world to people you dislike. They are already working overtime.",
    "What you call your limit is someone else’s starting point.",
    "Life holds more than today’s struggles. There are next year’s struggles too.",
    "You are not waiting for an opportunity. You are waiting to clock out.",
    "Others win at the starting line. You win a good view from the sidelines.",
    "Do not travel so far that you forget why you started. Not that you will get that far.",
    "When life closes a door, it may shut the window on its way out.",
    "You do not lack opportunities. You lack the ability to catch them.",
    "Keep going today. Otherwise, even tomorrow’s excuses will be hard to find.",
] as const;

export const soupAuthor = (locale: string): string => locale.toLowerCase().startsWith('en') ? 'SuperWagie' : SOUP_AUTHOR;

/** Day number in UTC so a DST change cannot repeat or skip a quote. */
const dayNumber = (date: Date): number =>
    Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000);

export const soupFor = (date: Date, locale = 'zh-CN'): string => {
    const index = ((dayNumber(date) % DAILY_SOUP.length) + DAILY_SOUP.length) % DAILY_SOUP.length;
    const quotes = locale.toLowerCase().startsWith('en') ? ENGLISH_SOUP : DAILY_SOUP;
    return quotes[index] ?? quotes[0];
};
