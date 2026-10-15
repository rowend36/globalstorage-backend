import { configuration } from './src/config/configuration';
import { mikroOrmOptions } from './src/database/mikro-orm.config';

export default mikroOrmOptions(configuration());
