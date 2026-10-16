import { Module } from '@nestjs/common';
import { EngineModule } from '../engine/engine.module';
import { KeysController } from './keys.controller';
import { SpacesController } from './spaces.controller';

@Module({
  imports: [EngineModule],
  controllers: [SpacesController, KeysController],
})
export class SpacesModule {}
