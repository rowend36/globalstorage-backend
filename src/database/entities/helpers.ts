import { p } from '@mikro-orm/core';

export const uuid = () =>
  p
    .uuid()
    .primary()
    .onCreate(() => crypto.randomUUID());
