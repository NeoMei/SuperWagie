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

/** Day number in UTC so a DST change cannot repeat or skip a quote. */
const dayNumber = (date: Date): number =>
    Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000);

export const soupFor = (date: Date): string => {
    const index = ((dayNumber(date) % DAILY_SOUP.length) + DAILY_SOUP.length) % DAILY_SOUP.length;
    return DAILY_SOUP[index] ?? DAILY_SOUP[0];
};
